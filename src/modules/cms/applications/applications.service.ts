import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../revalidation/revalidation.service';
import { CmsTags } from '../../revalidation/cms-tags';
import {
  ApplicationProductItemDto,
  CreateApplicationDto,
  UpdateApplicationDto,
} from './dto/application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
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
  toApplicationDetail,
  toApplicationListItem,
  type ApplicationDetailDto,
  type ApplicationWithRelations,
  type PaginatedApplicationsDto,
} from './entities/application.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

const APPLICATION_INCLUDE = {
  coverMedia: true,
  products: { include: { product: true } },
  _count: { select: { products: true } },
} satisfies Prisma.ApplicationInclude;

/**
 * 产品应用场景 CMS 服务（Phase 4.5）。
 *
 * 关联完整性要点：
 *   · 产品关联用显式多对多表 application_products，**不用产品名字符串匹配**
 *   · productId 先做批量存在性校验，非法引用返回 400 而非外键异常
 *   · 关联集合整体替换：删除未出现的、更新携带的、新建新增的（保留 sortOrder）
 *   · 删除应用场景只级联删除关联行（application_products），
 *     **绝不删除 Product 本身**（Product 侧 onDelete: Restrict 亦有一层保护）
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  /**
   * 应用场景变更后通知前台失效。
   *
   * 同时失效列表 tag 与实体 tag（详情页含关联产品）。
   */
  private notifyFrontend(slug?: string): void {
    void this.revalidation.invalidate({
      tags: [CmsTags.applications, ...(slug ? [CmsTags.application(slug)] : [])],
      // sitemap 含应用场景详情 URL，必须一并失效
      paths: ['/applications', '/sitemap.xml', ...(slug ? [`/applications/${slug}`] : [])],
    });
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 应用场景列表：分页 + keyword / status / featured 筛选 */
  async list(query: ListApplicationsQueryDto): Promise<PaginatedApplicationsDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.ApplicationWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.featured !== undefined) where.featured = query.featured;
    if (query.keyword) {
      where.OR = [
        { name: { contains: query.keyword, mode: 'insensitive' } },
        { slug: { contains: query.keyword, mode: 'insensitive' } },
        { summary: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.application.count({ where }),
      this.prisma.application.findMany({
        where,
        include: APPLICATION_INCLUDE,
        orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: (rows as ApplicationWithRelations[]).map(toApplicationListItem),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 详情 */
  async findById(id: string): Promise<ApplicationDetailDto> {
    const row = await this.prisma.application.findUnique({
      where: { id },
      include: APPLICATION_INCLUDE,
    });
    if (!row) throw new NotFoundException('Application not found.');
    return toApplicationDetail(row as ApplicationWithRelations);
  }

  /* ------------------------------ 创建 ------------------------------ */

  async create(dto: CreateApplicationDto): Promise<ApplicationDetailDto> {
    await this.assertSlugAvailable(dto.slug);

    const coverMediaId = dto.coverMediaId ?? null;
    if (coverMediaId) await this.assertMediaExists(coverMediaId);

    const productItems = dto.products ?? [];
    await this.assertProductsExist(productItems.map((item) => item.productId));

    const coverUrl = coverMediaId ? await this.resolveMediaUrl(coverMediaId) : null;

    const created = await this.prisma.$transaction(async (tx) => {
      const application = await tx.application.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          summary: dto.summary ?? null,
          description: dto.description ?? null,
          coverMediaId,
          coverImageUrl: coverUrl,
          // Phase 1：创建一律为草稿，发布只能经独立 publish 动作
          status: ContentStatus.DRAFT,
          featured: dto.featured ?? false,
          sortOrder: dto.sortOrder ?? 0,
          publishedAt: null,
          seoTitle: dto.seoTitle ?? null,
          seoDescription: dto.seoDescription ?? null,
        },
      });

      if (productItems.length > 0) {
        await tx.applicationProduct.createMany({
          data: this.dedupeProducts(productItems).map((item, index) => ({
            applicationId: application.id,
            productId: item.productId,
            sortOrder: item.sortOrder ?? index,
          })),
        });
      }

      return tx.application.findUniqueOrThrow({
        where: { id: application.id },
        include: APPLICATION_INCLUDE,
      });
    });

    this.notifyFrontend(created.slug);
    return toApplicationDetail(created as ApplicationWithRelations);
  }

  /* ------------------------------ 更新 ------------------------------ */

  /**
   * 更新应用场景。
   *
   * ctx.tx 传入时在既有事务内执行（发布流程应用编辑稿时使用）；
   * 否则自行开启事务。
   */
  async update(
    id: string,
    dto: UpdateApplicationDto,
    ctx: { tx?: Prisma.TransactionClient; skipNotify?: boolean } = {},
  ): Promise<ApplicationDetailDto> {
    const existing = await this.prisma.application.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Application not found.');

    if (dto.slug && dto.slug !== existing.slug) {
      await this.assertSlugAvailable(dto.slug);
    }

    const { coverMediaId, coverImageUrl } = await this.prepareUpdate(
      dto,
      existing,
      ctx.tx ?? this.prisma,
    );

    const apply = (tx: Prisma.TransactionClient) =>
      this.applyUpdate(tx, id, dto, coverMediaId, coverImageUrl);

    const row = ctx.tx ? await apply(ctx.tx) : await this.prisma.$transaction(apply);
    if (!ctx.skipNotify) this.notifyFrontend();
    return toApplicationDetail(row);
  }

  /** 在事务内落库字段 + 关联产品，返回带关联的最新行 */
  private async applyUpdate(
    tx: Prisma.TransactionClient,
    id: string,
    dto: UpdateApplicationDto,
    coverMediaId: string | null,
    coverImageUrl: string | null,
  ): Promise<ApplicationWithRelations> {
    await tx.application.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.featured !== undefined ? { featured: dto.featured } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.seoTitle !== undefined ? { seoTitle: dto.seoTitle } : {}),
        ...(dto.seoDescription !== undefined ? { seoDescription: dto.seoDescription } : {}),
        coverMediaId,
        coverImageUrl,
        // status / publishedAt 不在 DTO 中，此处不触碰
      },
    });

    if (dto.products !== undefined) {
      await this.syncProducts(tx, id, dto.products);
    }

    return (await tx.application.findUniqueOrThrow({
      where: { id },
      include: APPLICATION_INCLUDE,
    })) as ApplicationWithRelations;
  }

  /* --------------------------- 发布工作流 --------------------------- */

  /**
   * 发布适配器：把应用场景模块接入通用引擎。
   *
   * 发布完整性校验：name / slug 非空。
   * 关联产品为可选项（B2B 场景允许先上线场景页再补产品）。
   */
  private publishingAdapter(): PublishAdapter<ApplicationWithRelations> {
    return {
      entityType: 'APPLICATION',
      label: '应用场景',
      findRow: async (id) =>
        (await this.prisma.application.findUnique({
          where: { id },
          include: APPLICATION_INCLUDE,
        })) as ApplicationWithRelations | null,
      applyDraft: async (id, payload, tx) => {
        if (!payload) {
          const row = await tx.application.findUnique({
            where: { id },
            include: APPLICATION_INCLUDE,
          });
          if (!row) throw new NotFoundException('Application not found.');
          return row as ApplicationWithRelations;
        }

        const dto = payload as UpdateApplicationDto;
        const existing = await tx.application.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException('Application not found.');

        if (dto.slug && dto.slug !== existing.slug) {
          const taken = await tx.application.findUnique({
            where: { slug: dto.slug },
            select: { id: true },
          });
          if (taken) throw new ConflictException(`slug 已被占用：${dto.slug}`);
        }

        const { coverMediaId, coverImageUrl } = await this.prepareUpdate(dto, existing, tx);
        return this.applyUpdate(tx, id, dto, coverMediaId, coverImageUrl);
      },
      markPublished: async (id, nextVersion, tx) => {
        const current = await tx.application.findUnique({
          where: { id },
          select: { publishedAt: true },
        });
        return tx.application.update({
          where: { id },
          data: {
            status: ContentStatus.PUBLISHED,
            publishedAt: current?.publishedAt ?? new Date(),
            version: { increment: 1 },
            publishedVersion: nextVersion,
          },
          include: APPLICATION_INCLUDE,
        }) as Promise<ApplicationWithRelations>;
      },
      markUnpublished: async (id, tx) =>
        tx.application.update({
          where: { id },
          // 保留内容、publishedAt 与发布历史
          data: { status: ContentStatus.UNPUBLISHED, version: { increment: 1 } },
          include: APPLICATION_INCLUDE,
        }) as Promise<ApplicationWithRelations>,
      validate: (row) => {
        requireText(row.name, '名称', '应用场景');
        requireText(row.slug, 'URL 别名（slug）', '应用场景');
      },
      toSnapshot: (row) => toApplicationDetail(row),
    };
  }

  /** 发布状态快照（供控制器决定「直接改行」还是「写编辑稿」） */
  publishState(id: string): Promise<PublishState> {
    return getPublishState(this.prisma, this.publishingAdapter(), id);
  }

  /** 保存编辑稿（已发布场景不再直接改写线上行） */
  saveDraft(
    id: string,
    dto: UpdateApplicationDto,
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
  async publish(id: string, actorId: string | null): Promise<ApplicationDetailDto> {
    const result = await publishEntity(this.prisma, this.publishingAdapter(), id, actorId);
    this.notifyFrontend(result.row.slug);
    return withPublishMeta(toApplicationDetail(result.row), result);
  }

  /** 取消发布：保留内容与历史，公开侧立即不可见 */
  async unpublish(id: string): Promise<ApplicationDetailDto> {
    const result = await unpublishEntity(this.prisma, this.publishingAdapter(), id);
    this.notifyFrontend(result.row.slug);
    return withPublishMeta(toApplicationDetail(result.row), result);
  }

  /** 预览：线上版本 + 编辑稿（仅后台授权访问） */
  preview(id: string) {
    return previewEntity(this.prisma, this.publishingAdapter(), id, (row) =>
      toApplicationDetail(row),
    );
  }

  /** 发布历史 */
  revisions(id: string) {
    return listEntityRevisions(this.prisma, this.publishingAdapter(), id);
  }

  /* ------------------------------ 删除 ------------------------------ */

  /**
   * 删除应用场景。
   *
   * 级联删除 application_products 关联行；**不删除任何 Product**。
   */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.application.findUnique({
      where: { id },
      select: { id: true, slug: true },
    });
    if (!existing) throw new NotFoundException('Application not found.');

    await this.prisma.$transaction([
      // 通用发布表按 entityType+entityId 关联，无外键 → 随主体一并清理
      this.prisma.contentDraft.deleteMany({ where: { entityType: 'APPLICATION', entityId: id } }),
      this.prisma.contentRevision.deleteMany({ where: { entityType: 'APPLICATION', entityId: id } }),
      this.prisma.application.delete({ where: { id } }),
    ]);
    this.notifyFrontend(existing.slug);
    return { id };
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  /**
   * 解析更新所需的封面字段并校验关联产品存在。
   * 直接保存与「发布时应用编辑稿」共用，避免两条路径校验不一致。
   */
  private async prepareUpdate(
    dto: UpdateApplicationDto,
    existing: { coverMediaId: string | null; coverImageUrl: string | null },
    db: PrismaService | Prisma.TransactionClient,
  ): Promise<{ coverMediaId: string | null; coverImageUrl: string | null }> {
    let coverMediaId = existing.coverMediaId;
    let coverImageUrl = existing.coverImageUrl;

    if (dto.coverMediaId !== undefined) {
      if (dto.coverMediaId === null) {
        coverMediaId = null;
        coverImageUrl = null;
      } else {
        const media = await db.mediaAsset.findUnique({
          where: { id: dto.coverMediaId },
          select: { id: true, url: true },
        });
        if (!media) throw new BadRequestException(`媒体资源不存在：${dto.coverMediaId}`);
        coverMediaId = media.id;
        coverImageUrl = media.url;
      }
    }

    if (dto.products !== undefined) {
      await this.assertProductsExist(
        dto.products.map((item) => item.productId),
        db,
      );
    }

    return { coverMediaId, coverImageUrl };
  }

  /**
   * 关联产品集合同步：整体替换语义。
   *   · 不在新集合中的旧关联 → 删除
   *   · 新集合中的关联 → upsert（保留/更新 sortOrder）
   * 全部基于 (applicationId, productId) 复合主键，保证幂等。
   */
  private async syncProducts(
    tx: Prisma.TransactionClient,
    applicationId: string,
    items: ApplicationProductItemDto[],
  ): Promise<void> {
    const deduped = this.dedupeProducts(items);
    const keepIds = deduped.map((item) => item.productId);

    await tx.applicationProduct.deleteMany({
      where: {
        applicationId,
        ...(keepIds.length > 0 ? { productId: { notIn: keepIds } } : {}),
      },
    });

    for (const [index, item] of deduped.entries()) {
      await tx.applicationProduct.upsert({
        where: {
          applicationId_productId: { applicationId, productId: item.productId },
        },
        create: {
          applicationId,
          productId: item.productId,
          sortOrder: item.sortOrder ?? index,
        },
        update: { sortOrder: item.sortOrder ?? index },
      });
    }
  }

  /** 去重：同一 productId 只保留首次出现（避免复合主键冲突） */
  private dedupeProducts(items: ApplicationProductItemDto[]): ApplicationProductItemDto[] {
    const seen = new Set<string>();
    const result: ApplicationProductItemDto[] = [];
    for (const item of items) {
      if (seen.has(item.productId)) continue;
      seen.add(item.productId);
      result.push(item);
    }
    return result;
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    const taken = await this.prisma.application.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (taken) throw new ConflictException(`slug 已被占用：${slug}`);
  }

  private async assertMediaExists(mediaId: string): Promise<void> {
    const found = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { id: true },
    });
    if (!found) throw new BadRequestException(`媒体资源不存在：${mediaId}`);
  }

  /** 批量产品存在性校验：去重后比对数量，报告缺失 id */
  private async assertProductsExist(
    productIds: string[],
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) return;
    const found = await db.product.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      const foundSet = new Set(found.map((row) => row.id));
      const missing = unique.filter((id) => !foundSet.has(id));
      throw new BadRequestException(`产品不存在：${missing.join(', ')}`);
    }
  }

  private async resolveMediaUrl(mediaId: string): Promise<string> {
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { url: true },
    });
    if (!media) throw new BadRequestException(`媒体资源不存在：${mediaId}`);
    return media.url;
  }

  /**
   * 发布时间说明（Phase 1）：
   *   · 发布时间由 publish 动作在服务端写入，不再由调用方传入
   *   · 首次发布 → now；重新发布 → 沿用首次发布时间
   *   · 取消发布 → 保留原值
   */
}
