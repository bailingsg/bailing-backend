import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PostStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../revalidation/revalidation.service';
import { CmsTags } from '../../revalidation/cms-tags';
import { CreateBlogPostDto, UpdateBlogPostDto } from './dto/blog-post.dto';
import { ListBlogPostsQueryDto } from './dto/list-blog-posts-query.dto';
import { sanitizeRichText } from './rich-text.sanitizer';
import {
  getPublishState,
  listEntityRevisions,
  previewEntity,
  publishEntity,
  requireText,
  saveEntityDraft,
  unpublishEntity,
  withPublishMeta,
  type PublishAdapter,
  type PublishState,
} from '../publishing/publishing.engine';
import {
  toBlogPostDetail,
  toBlogPostListItem,
  type BlogPostDetailDto,
  type BlogPostWithRelations,
  type PaginatedBlogPostsDto,
} from './entities/blog.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/** 文章列表/详情的关联加载（不含 storageKey 等内部字段） */
const BLOG_POST_INCLUDE = {
  category: { select: { id: true, name: true, slug: true } },
  author: { select: { id: true, name: true } },
  coverMedia: { select: { id: true, url: true, altText: true, width: true, height: true } },
  tags: { include: { tag: { select: { id: true, name: true, slug: true } } } },
} satisfies Prisma.BlogPostInclude;

/**
 * 博客文章 CMS 服务（Phase 4.4）。
 *
 * 安全要点：
 *   · 富文本 content 一律经 sanitizeRichText 白名单净化后才入库（防存储型 XSS）
 *   · categoryId / coverMediaId / tagIds 先做存在性校验，返回 400 而非外键异常
 *   · 封面只允许引用 Media Library 中已存在的资产（禁止本模块自行上传文件）
 */
@Injectable()
export class BlogPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  /**
   * 文章变更后通知前台失效（Phase 4.8）。
   *
   * 覆盖：文章列表、分类计数、文章详情路径。删除时传 slug，
   * 保证已删除文章的详情页立即 404（而非继续命中旧缓存）。
   */
  private notifyFrontend(slug?: string): void {
    void this.revalidation.invalidate({
      tags: [CmsTags.blog, CmsTags.blogCategories, ...(slug ? [CmsTags.blogPost(slug)] : [])],
      // sitemap 含文章详情 URL，必须一并失效
      paths: ['/blog', '/sitemap.xml', ...(slug ? [`/blog/${slug}`] : [])],
    });
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 文章列表：分页 + keyword / status / categoryId / tagId / featured 筛选 */
  async list(query: ListBlogPostsQueryDto): Promise<PaginatedBlogPostsDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.BlogPostWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.featured !== undefined) where.featured = query.featured;
    if (query.tagId) where.tags = { some: { tagId: query.tagId } };
    if (query.keyword) {
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { slug: { contains: query.keyword, mode: 'insensitive' } },
        { excerpt: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.blogPost.count({ where }),
      this.prisma.blogPost.findMany({
        where,
        include: BLOG_POST_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: (rows as BlogPostWithRelations[]).map(toBlogPostListItem),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 文章详情（编辑页数据源；不存在 404） */
  async findById(id: string): Promise<BlogPostDetailDto> {
    const post = await this.prisma.blogPost.findUnique({ where: { id }, include: BLOG_POST_INCLUDE });
    if (!post) throw new NotFoundException('文章不存在');
    return toBlogPostDetail(post as BlogPostWithRelations);
  }

  /* ------------------------------ 写入 ------------------------------ */

  /** 创建文章 */
  async create(dto: CreateBlogPostDto, authorId: string | null): Promise<BlogPostDetailDto> {
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);
    const cover = await this.resolveCoverMedia(dto.coverMediaId);
    const tagIds = await this.resolveTagIds(dto.tagIds);

    try {
      const created = await this.prisma.blogPost.create({
        data: {
          title: dto.title,
          slug: dto.slug,
          excerpt: dto.excerpt ?? null,
          content: sanitizeRichText(dto.content),
          coverMediaId: dto.coverMediaId ?? null,
          coverImageUrl: cover?.url ?? null,
          categoryId: dto.categoryId ?? null,
          // Phase 1：创建一律为草稿，发布只能经独立 publish 动作
          status: PostStatus.DRAFT,
          featured: dto.featured ?? false,
          publishedAt: null,
          authorId,
          seoTitle: dto.seoTitle ?? null,
          seoDescription: dto.seoDescription ?? null,
          seoKeywords: dto.seoKeywords ?? null,
          canonicalUrl: dto.canonicalUrl ?? null,
          ogTitle: dto.ogTitle ?? null,
          ogDescription: dto.ogDescription ?? null,
          ogImage: dto.ogImage ?? null,
          twitterTitle: dto.twitterTitle ?? null,
          twitterDescription: dto.twitterDescription ?? null,
          tags: tagIds.length > 0 ? { create: tagIds.map((tagId) => ({ tagId })) } : undefined,
        },
        include: BLOG_POST_INCLUDE,
      });
      this.notifyFrontend(created.slug);
      return toBlogPostDetail(created as BlogPostWithRelations);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /**
   * 从 Update DTO 构造 Prisma 更新数据（直接保存与「发布时应用编辑稿」共用）。
   * 返回的 tagIds 为 undefined 时表示本次不改标签关联。
   */
  private async buildUpdateData(
    dto: UpdateBlogPostDto,
    db: PrismaService | Prisma.TransactionClient,
  ): Promise<{ data: Prisma.BlogPostUpdateInput; tagIds: string[] | undefined }> {
    if (dto.categoryId) {
      const category = await db.blogCategory.findUnique({
        where: { id: dto.categoryId },
        select: { id: true },
      });
      if (!category) throw new BadRequestException('博客分类不存在，请先创建或选择有效分类');
    }
    const cover =
      dto.coverMediaId === undefined ? undefined : await this.resolveCoverMedia(dto.coverMediaId, db);
    const tagIds = dto.tagIds === undefined ? undefined : await this.resolveTagIds(dto.tagIds, db);

    const data: Prisma.BlogPostUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.excerpt !== undefined) data.excerpt = dto.excerpt;
    if (dto.content !== undefined) data.content = sanitizeRichText(dto.content);
    if (dto.categoryId !== undefined) {
      data.category = dto.categoryId ? { connect: { id: dto.categoryId } } : { disconnect: true };
    }
    if (cover !== undefined) {
      data.coverMedia = cover ? { connect: { id: cover.id } } : { disconnect: true };
      // 同步封面地址快照，保证公开站无需二次查询
      data.coverImageUrl = cover ? cover.url : null;
    }
    if (dto.featured !== undefined) data.featured = dto.featured;
    if (dto.seoTitle !== undefined) data.seoTitle = dto.seoTitle;
    if (dto.seoDescription !== undefined) data.seoDescription = dto.seoDescription;
    if (dto.seoKeywords !== undefined) data.seoKeywords = dto.seoKeywords;
    if (dto.canonicalUrl !== undefined) data.canonicalUrl = dto.canonicalUrl;
    if (dto.ogTitle !== undefined) data.ogTitle = dto.ogTitle;
    if (dto.ogDescription !== undefined) data.ogDescription = dto.ogDescription;
    if (dto.ogImage !== undefined) data.ogImage = dto.ogImage;
    if (dto.twitterTitle !== undefined) data.twitterTitle = dto.twitterTitle;
    if (dto.twitterDescription !== undefined) data.twitterDescription = dto.twitterDescription;

    // 注意：status / publishedAt 已从 DTO 移除，此处不再处理，
    // 发布态只能由 publish / unpublish 变更。
    return { data, tagIds };
  }

  /** 更新文章（PATCH：三态语义 —— undefined 保持 / null 置空 / 有值覆盖） */
  async update(
    id: string,
    dto: UpdateBlogPostDto,
    ctx: { tx?: Prisma.TransactionClient; skipNotify?: boolean } = {},
  ): Promise<BlogPostDetailDto> {
    const existing = await this.prisma.blogPost.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('文章不存在');

    const { data, tagIds } = await this.buildUpdateData(dto, ctx.tx ?? this.prisma);

    try {
      const apply = async (tx: Prisma.TransactionClient) => {
        if (tagIds !== undefined) {
          await tx.blogPostTag.deleteMany({ where: { postId: id } });
          if (tagIds.length > 0) {
            await tx.blogPostTag.createMany({
              data: tagIds.map((tagId) => ({ postId: id, tagId })),
            });
          }
        }
        return tx.blogPost.update({ where: { id }, data, include: BLOG_POST_INCLUDE });
      };

      const updated = ctx.tx ? await apply(ctx.tx) : await this.prisma.$transaction(apply);
      if (!ctx.skipNotify) this.notifyFrontend(updated.slug);
      return toBlogPostDetail(updated as BlogPostWithRelations);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 删除文章（BlogPostTag 由 schema 级联删除） */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.blogPost.findUnique({
      where: { id },
      select: { id: true, slug: true },
    });
    if (!existing) throw new NotFoundException('文章不存在');

    await this.prisma.$transaction([
      // 通用发布表按 entityType+entityId 关联，无外键 → 随主体一并清理
      this.prisma.contentDraft.deleteMany({ where: { entityType: 'BLOG_POST', entityId: id } }),
      this.prisma.contentRevision.deleteMany({ where: { entityType: 'BLOG_POST', entityId: id } }),
      this.prisma.blogPost.delete({ where: { id } }),
    ]);
    this.notifyFrontend(existing.slug);
    return { id };
  }

  /* --------------------------- 发布工作流 --------------------------- */

  /**
   * 发布适配器：把文章模块的字段映射 / 校验 / 快照接入通用引擎。
   *
   * 文章发布完整性校验：
   *   · title / slug / content 非空 —— 详情页与 SEO 的最低要求
   *   · 首次发布自动写入 publishedAt（之后重新发布保留首次发布时间）
   */
  private publishingAdapter(): PublishAdapter<BlogPostWithRelations> {
    return {
      entityType: 'BLOG_POST',
      label: '文章',
      findRow: async (id) =>
        (await this.prisma.blogPost.findUnique({
          where: { id },
          include: BLOG_POST_INCLUDE,
        })) as BlogPostWithRelations | null,
      applyDraft: async (id, payload, tx) => {
        if (!payload) {
          const row = await tx.blogPost.findUnique({ where: { id }, include: BLOG_POST_INCLUDE });
          if (!row) throw new NotFoundException('文章不存在');
          return row as BlogPostWithRelations;
        }
        const dto = payload as UpdateBlogPostDto;
        const { data, tagIds } = await this.buildUpdateData(dto, tx);
        if (tagIds !== undefined) {
          await tx.blogPostTag.deleteMany({ where: { postId: id } });
          if (tagIds.length > 0) {
            await tx.blogPostTag.createMany({ data: tagIds.map((tagId) => ({ postId: id, tagId })) });
          }
        }
        return tx.blogPost.update({
          where: { id },
          data,
          include: BLOG_POST_INCLUDE,
        }) as Promise<BlogPostWithRelations>;
      },
      markPublished: async (id, nextVersion, tx) => {
        const current = await tx.blogPost.findUnique({
          where: { id },
          select: { publishedAt: true },
        });
        return tx.blogPost.update({
          where: { id },
          data: {
            status: PostStatus.PUBLISHED,
            publishedAt: current?.publishedAt ?? new Date(),
            version: { increment: 1 },
            publishedVersion: nextVersion,
          },
          include: BLOG_POST_INCLUDE,
        }) as Promise<BlogPostWithRelations>;
      },
      markUnpublished: async (id, tx) =>
        tx.blogPost.update({
          where: { id },
          // 保留 publishedAt 与全部内容：重新发布时沿用首次发布时间，避免 SEO 时间线抖动
          data: { status: PostStatus.UNPUBLISHED, version: { increment: 1 } },
          include: BLOG_POST_INCLUDE,
        }) as Promise<BlogPostWithRelations>,
      validate: (row) => {
        requireText(row.title, '标题', '文章');
        requireText(row.slug, 'URL 别名（slug）', '文章');
        requireText(row.content, '正文', '文章');
      },
      toSnapshot: (row) => toBlogPostDetail(row),
    };
  }

  /** 发布状态快照（供控制器决定「直接改行」还是「写编辑稿」） */
  publishState(id: string): Promise<PublishState> {
    return getPublishState(this.prisma, this.publishingAdapter(), id);
  }

  /** 保存编辑稿（已发布文章不再直接改写线上行） */
  saveDraft(
    id: string,
    dto: UpdateBlogPostDto,
    actorId: string | null,
    expectedVersion?: number,
  ): Promise<{ draftVersion: number; updatedAt: Date; baseVersion: number }> {
    return saveEntityDraft(
      this.prisma,
      this.publishingAdapter(),
      id,
      dto as Record<string, unknown>,
      actorId,
      expectedVersion,
    );
  }

  /** 发布：把编辑稿应用为线上版本（事务内完成，失败不影响旧版本） */
  async publish(id: string, actorId: string | null): Promise<BlogPostDetailDto> {
    const result = await publishEntity(this.prisma, this.publishingAdapter(), id, actorId);
    this.notifyFrontend(result.row.slug);
    return withPublishMeta(toBlogPostDetail(result.row), result);
  }

  /** 取消发布：保留内容与历史，公开侧立即不可见 */
  async unpublish(id: string): Promise<BlogPostDetailDto> {
    const result = await unpublishEntity(this.prisma, this.publishingAdapter(), id);
    this.notifyFrontend(result.row.slug);
    return withPublishMeta(toBlogPostDetail(result.row), result);
  }

  /** 预览：线上版本 + 编辑稿（仅后台授权访问） */
  preview(id: string) {
    return previewEntity(this.prisma, this.publishingAdapter(), id, (row) => toBlogPostDetail(row));
  }

  /** 发布历史 */
  revisions(id: string) {
    return listEntityRevisions(this.prisma, this.publishingAdapter(), id);
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.blogCategory.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new BadRequestException('博客分类不存在，请先创建或选择有效分类');
  }

  /** 校验封面媒体存在并返回其 url（用于同步 coverImageUrl 快照） */
  private async resolveCoverMedia(
    coverMediaId: string | null | undefined,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<{ id: string; url: string } | null> {
    if (!coverMediaId) return null;
    const asset = await db.mediaAsset.findUnique({
      where: { id: coverMediaId },
      select: { id: true, url: true },
    });
    if (!asset) throw new BadRequestException('封面媒体不存在，请先从媒体库上传或选择图片');
    return asset;
  }

  /** 校验标签集合存在，返回去重后的 id 列表（顺序保持首次出现顺序） */
  private async resolveTagIds(
    tagIds: string[] | undefined,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<string[]> {
    if (!tagIds || tagIds.length === 0) return [];
    const unique = [...new Set(tagIds)];
    const found = await db.blogTag.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      const foundSet = new Set(found.map((t) => t.id));
      const missing = unique.filter((t) => !foundSet.has(t));
      throw new BadRequestException(`标签不存在: ${missing.join(', ')}`);
    }
    return unique;
  }

  /** slug 唯一冲突 → 409；P2025 → 404；其余包装 500 */
  private mapWriteError(error: unknown, slug?: string): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002' && slug) {
        return new ConflictException(`文章 slug 已存在: ${slug}`);
      }
      if (error.code === 'P2003') {
        return new BadRequestException('关联资源不存在（分类 / 标签 / 封面媒体）');
      }
      if (error.code === 'P2025') {
        return new NotFoundException('文章不存在');
      }
    }
    return new InternalServerErrorException('写入失败，请稍后重试');
  }
}
