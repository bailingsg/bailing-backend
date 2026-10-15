import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PostStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBlogPostDto, UpdateBlogPostDto } from './dto/blog-post.dto';
import { ListBlogPostsQueryDto } from './dto/list-blog-posts-query.dto';
import { sanitizeRichText } from './rich-text.sanitizer';
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
  constructor(private readonly prisma: PrismaService) {}

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

    const status = dto.status ?? PostStatus.DRAFT;
    const publishedAt = this.resolvePublishedAtOnCreate(dto.publishedAt, status);

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
          status,
          featured: dto.featured ?? false,
          publishedAt,
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
      return toBlogPostDetail(created as BlogPostWithRelations);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 更新文章（PATCH：三态语义 —— undefined 保持 / null 置空 / 有值覆盖） */
  async update(id: string, dto: UpdateBlogPostDto): Promise<BlogPostDetailDto> {
    const existing = await this.prisma.blogPost.findUnique({
      where: { id },
      select: { id: true, status: true, publishedAt: true },
    });
    if (!existing) throw new NotFoundException('文章不存在');

    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);
    const cover = dto.coverMediaId === undefined ? undefined : await this.resolveCoverMedia(dto.coverMediaId);
    const tagIds = dto.tagIds === undefined ? undefined : await this.resolveTagIds(dto.tagIds);

    const data: Prisma.BlogPostUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.excerpt !== undefined) data.excerpt = dto.excerpt;
    if (dto.content !== undefined) data.content = sanitizeRichText(dto.content);
    if (dto.categoryId !== undefined) data.category = dto.categoryId ? { connect: { id: dto.categoryId } } : { disconnect: true };
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

    // 状态与发布时间
    const nextStatus = dto.status ?? existing.status;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.publishedAt !== undefined) {
      data.publishedAt = dto.publishedAt === null ? null : new Date(dto.publishedAt);
    } else if (
      nextStatus === PostStatus.PUBLISHED &&
      existing.status !== PostStatus.PUBLISHED &&
      existing.publishedAt === null
    ) {
      // 首次发布：自动记录发布时间
      data.publishedAt = new Date();
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (tagIds !== undefined) {
          await tx.blogPostTag.deleteMany({ where: { postId: id } });
          if (tagIds.length > 0) {
            await tx.blogPostTag.createMany({
              data: tagIds.map((tagId) => ({ postId: id, tagId })),
            });
          }
        }
        return tx.blogPost.update({ where: { id }, data, include: BLOG_POST_INCLUDE });
      });
      return toBlogPostDetail(updated as BlogPostWithRelations);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 删除文章（BlogPostTag 由 schema 级联删除） */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.blogPost.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('文章不存在');

    await this.prisma.blogPost.delete({ where: { id } });
    return { id };
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 发布时间：显式提供优先；否则首次发布置当前时间；草稿为 null */
  private resolvePublishedAtOnCreate(publishedAt: string | undefined, status: PostStatus): Date | null {
    if (publishedAt) return new Date(publishedAt);
    return status === PostStatus.PUBLISHED ? new Date() : null;
  }

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
  ): Promise<{ id: string; url: string } | null> {
    if (!coverMediaId) return null;
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: coverMediaId },
      select: { id: true, url: true },
    });
    if (!asset) throw new BadRequestException('封面媒体不存在，请先从媒体库上传或选择图片');
    return asset;
  }

  /** 校验标签集合存在，返回去重后的 id 列表（顺序保持首次出现顺序） */
  private async resolveTagIds(tagIds: string[] | undefined): Promise<string[]> {
    if (!tagIds || tagIds.length === 0) return [];
    const unique = [...new Set(tagIds)];
    const found = await this.prisma.blogTag.findMany({
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
