import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentStatus, FactorySectionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../revalidation/revalidation.service';
import { CmsTags } from '../../revalidation/cms-tags';
import { sanitizeRichText } from '../blog/rich-text.sanitizer';
import {
  CreateFactorySectionDto,
  FactoryExhibitionItemDto,
  UpdateFactorySectionDto,
} from './dto/factory-section.dto';
import { ListFactorySectionsQueryDto } from './dto/list-factory-sections-query.dto';
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
  toFactorySectionDetail,
  toFactorySectionListItem,
  type FactorySectionDetailDto,
  type FactorySectionWithRelations,
  type PaginatedFactorySectionsDto,
} from './entities/factory.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/** 报名/展会/图库的关联加载（媒体只取公开渲染字段） */
const FACTORY_SECTION_INCLUDE = {
  coverMedia: true,
  images: { include: { media: true } },
  exhibitions: {
    include: { photos: { include: { media: true } } },
  },
} satisfies Prisma.FactorySectionInclude;

/**
 * 工厂实力 CMS 服务（Phase 4.5）。
 *
 * 安全与一致性要点：
 *   · content 经 sanitizeRichText 白名单净化后入库（防存储型 XSS）
 *   · coverMediaId / images[].mediaId / exhibitions[].photos[].mediaId
 *     先做**存在性校验**，返回 400 而非外键异常
 *   · 图片一律引用 Media Library 资产——本模块**不允许**自行上传文件
 *   · 删除分区只级联删除关联行（factory_images / factory_exhibitions），
 *     **绝不删除 MediaAsset 本身**（媒体删除由 MediaService 的引用检查兜底）
 */
@Injectable()
export class FactorySectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  /** 工厂内容变更后通知前台失效（工厂页含分区正文、图库与展会照片） */
  private notifyFrontend(): void {
    void this.revalidation.invalidate({
      tags: [CmsTags.factory],
      paths: ['/factory'],
    });
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 分区列表：分页 + keyword / sectionType / status 筛选，按 sortOrder 升序 */
  async list(query: ListFactorySectionsQueryDto): Promise<PaginatedFactorySectionsDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.FactorySectionWhereInput = {};
    if (query.sectionType) where.sectionType = query.sectionType;
    if (query.status) where.status = query.status;
    if (query.keyword) {
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { slug: { contains: query.keyword, mode: 'insensitive' } },
        { summary: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.factorySection.count({ where }),
      this.prisma.factorySection.findMany({
        where,
        include: FACTORY_SECTION_INCLUDE,
        orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: (rows as FactorySectionWithRelations[]).map(toFactorySectionListItem),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 分区详情 */
  async findById(id: string): Promise<FactorySectionDetailDto> {
    const row = await this.prisma.factorySection.findUnique({
      where: { id },
      include: FACTORY_SECTION_INCLUDE,
    });
    if (!row) throw new NotFoundException('Factory section not found.');
    return toFactorySectionDetail(row as FactorySectionWithRelations);
  }

  /* ------------------------------ 创建 ------------------------------ */

  async create(dto: CreateFactorySectionDto): Promise<FactorySectionDetailDto> {
    await this.assertSlugAvailable(dto.slug);

    const coverMediaId = dto.coverMediaId ?? null;
    if (coverMediaId) await this.assertMediaExists(coverMediaId);

    // 图库与展会照片的媒体存在性一次性校验（去重，减少往返）
    const imageItems = dto.images ?? [];
    const exhibitionItems = dto.exhibitions ?? [];
    await this.assertAllMediaExist([
      ...imageItems.map((image) => image.mediaId),
      ...exhibitionItems.flatMap((exhibition) => (exhibition.photos ?? []).map((photo) => photo.mediaId)),
    ]);

    const coverUrl = coverMediaId ? await this.resolveMediaUrl(coverMediaId) : null;

    const created = await this.prisma.$transaction(async (tx) => {
      const section = await tx.factorySection.create({
        data: {
          title: dto.title,
          slug: dto.slug,
          sectionType: dto.sectionType,
          summary: dto.summary ?? null,
          content: dto.content ? sanitizeRichText(dto.content) : null,
          coverMediaId,
          coverImageUrl: coverUrl,
          // Phase 1：创建一律为草稿，发布只能经独立 publish 动作
          status: ContentStatus.DRAFT,
          sortOrder: dto.sortOrder ?? 0,
          publishedAt: null,
          seoTitle: dto.seoTitle ?? null,
          seoDescription: dto.seoDescription ?? null,
        },
      });

      // 图库图：exhibitionId 恒为 null，与展会照片区分
      if (imageItems.length > 0) {
        await tx.factoryImage.createMany({
          data: imageItems.map((image, index) => ({
            sectionId: section.id,
            mediaId: image.mediaId,
            altText: image.altText ?? null,
            sortOrder: image.sortOrder ?? index,
            exhibitionId: null,
          })),
        });
      }

      // 展会：复用与 update 相同的同步逻辑
      if (exhibitionItems.length > 0) {
        await this.syncExhibitions(tx, section.id, exhibitionItems);
      }

      return tx.factorySection.findUniqueOrThrow({
        where: { id: section.id },
        include: FACTORY_SECTION_INCLUDE,
      });
    });

    this.notifyFrontend();
    return toFactorySectionDetail(created as FactorySectionWithRelations);
  }

  /* ------------------------------ 更新 ------------------------------ */

  /**
   * 更新工厂分区（PATCH）。
   *
   * ctx.tx 传入时在既有事务内执行（发布流程应用编辑稿时使用）；
   * 否则自行开启事务。
   */
  async update(
    id: string,
    dto: UpdateFactorySectionDto,
    ctx: { tx?: Prisma.TransactionClient; skipNotify?: boolean } = {},
  ): Promise<FactorySectionDetailDto> {
    const existing = await this.prisma.factorySection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Factory section not found.');

    if (dto.slug && dto.slug !== existing.slug) {
      await this.assertSlugAvailable(dto.slug);
    }

    // 封面：undefined = 不改动；null = 清空；字符串 = 换封面
    const { coverMediaId, coverImageUrl } = await this.prepareUpdate(
      dto,
      existing,
      this.prisma,
    );

    const apply = (tx: Prisma.TransactionClient) =>
      this.applyUpdate(tx, id, dto, coverMediaId, coverImageUrl);

    const row = ctx.tx ? await apply(ctx.tx) : await this.prisma.$transaction(apply);
    if (!ctx.skipNotify) this.notifyFrontend();
    return toFactorySectionDetail(row);
  }

  /** 在事务内落库分区字段 + 图库 + 展会，返回带关联的最新行 */
  private async applyUpdate(
    tx: Prisma.TransactionClient,
    id: string,
    dto: UpdateFactorySectionDto,
    coverMediaId: string | null,
    coverImageUrl: string | null,
  ): Promise<FactorySectionWithRelations> {
    await tx.factorySection.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.sectionType !== undefined ? { sectionType: dto.sectionType } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
        ...(dto.content !== undefined ? { content: sanitizeRichText(dto.content) } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.seoTitle !== undefined ? { seoTitle: dto.seoTitle } : {}),
        ...(dto.seoDescription !== undefined ? { seoDescription: dto.seoDescription } : {}),
        coverMediaId,
        coverImageUrl,
        // status / publishedAt 不在 DTO 中，此处不触碰
      },
    });

    // 图库整体替换：删除旧的「非展会」图，再插入新集合
    if (dto.images !== undefined) {
      await tx.factoryImage.deleteMany({ where: { sectionId: id, exhibitionId: null } });
      if (dto.images.length > 0) {
        await tx.factoryImage.createMany({
          data: dto.images.map((image, index) => ({
            sectionId: id,
            mediaId: image.mediaId,
            altText: image.altText ?? null,
            sortOrder: image.sortOrder ?? index,
            exhibitionId: null,
          })),
        });
      }
    }

    // 展会整体替换：按 id 复用既有记录（保留照片更新语义），无 id 则新建
    if (dto.exhibitions !== undefined) {
      await this.syncExhibitions(tx, id, dto.exhibitions);
    }

    return (await tx.factorySection.findUniqueOrThrow({
      where: { id },
      include: FACTORY_SECTION_INCLUDE,
    })) as FactorySectionWithRelations;
  }

  /** 展会集合同步：删除未出现的、更新携带 id 的、新建无 id 的 */
  private async syncExhibitions(
    tx: Prisma.TransactionClient,
    sectionId: string,
    items: FactoryExhibitionItemDto[],
  ): Promise<void> {
    const current = await tx.factoryExhibition.findMany({
      where: { sectionId },
      select: { id: true },
    });
    const keepIds = new Set(items.map((item) => item.id).filter((value): value is string => Boolean(value)));

    const toDelete = current.filter((row) => !keepIds.has(row.id)).map((row) => row.id);
    if (toDelete.length > 0) {
      // 级联删除这些展会下的照片关联行（媒体资产本身不动）
      await tx.factoryExhibition.deleteMany({ where: { id: { in: toDelete } } });
    }

    for (const [index, item] of items.entries()) {
      const payload = {
        name: item.name,
        heldOn: item.heldOn ? new Date(item.heldOn) : null,
        location: item.location ?? null,
        description: item.description ?? null,
        sortOrder: item.sortOrder ?? index,
        isVisible: item.isVisible ?? true,
      };

      let exhibitionId = item.id ?? null;
      if (exhibitionId) {
        const exists = await tx.factoryExhibition.findFirst({ where: { id: exhibitionId, sectionId } });
        if (!exists) throw new BadRequestException('Exhibition not found in this section.');
        await tx.factoryExhibition.update({ where: { id: exhibitionId }, data: payload });
      } else {
        const created = await tx.factoryExhibition.create({ data: { sectionId, ...payload } });
        exhibitionId = created.id;
      }

      // 照片整体替换
      await tx.factoryImage.deleteMany({ where: { exhibitionId } });
      const photos = item.photos ?? [];
      if (photos.length > 0) {
        await tx.factoryImage.createMany({
          data: photos.map((photo, photoIndex) => ({
            sectionId,
            exhibitionId,
            mediaId: photo.mediaId,
            altText: photo.altText ?? null,
            sortOrder: photo.sortOrder ?? photoIndex,
          })),
        });
      }
    }
  }

  /* ------------------------------ 删除 ------------------------------ */

  /**
   * 删除分区。
   *
   * 级联删除 factory_images 与 factory_exhibitions 的关联行；
   * **不删除任何 MediaAsset**——媒体是否可删由 MediaService 的引用检查独立判定。
   */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.factorySection.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Factory section not found.');

    await this.prisma.$transaction([
      // 通用发布表按 entityType+entityId 关联，无外键 → 随主体一并清理
      this.prisma.contentDraft.deleteMany({ where: { entityType: 'FACTORY_SECTION', entityId: id } }),
      this.prisma.contentRevision.deleteMany({
        where: { entityType: 'FACTORY_SECTION', entityId: id },
      }),
      this.prisma.factorySection.delete({ where: { id } }),
    ]);
    this.notifyFrontend();
    return { id };
  }

  /* ------------------------------ 展会子路由 ------------------------------ */

  /** 某分区下的展会列表 */
  async listExhibitions(sectionId: string) {
    await this.assertSectionExists(sectionId);
    const rows = await this.prisma.factoryExhibition.findMany({
      where: { sectionId },
      include: { photos: { include: { media: true } } },
      orderBy: [{ sortOrder: 'asc' }, { heldOn: 'desc' }, { id: 'asc' }],
    });
    // 复用详情映射器的展会部分，保证结构与主接口一致
    const { toFactoryExhibitionDto } = await import('./entities/factory.entity');
    return rows.map(toFactoryExhibitionDto);
  }

  /* --------------------------- 发布工作流 --------------------------- */

  /**
   * 发布适配器：把工厂分区模块的字段映射 / 校验 / 快照接入通用引擎。
   *
   * 发布完整性校验：title / slug 非空且 sectionType 合法
   * （图库与展会为可选项，不阻断发布）。
   */
  private publishingAdapter(): PublishAdapter<FactorySectionWithRelations> {
    return {
      entityType: 'FACTORY_SECTION',
      label: '工厂分区',
      findRow: async (id) =>
        (await this.prisma.factorySection.findUnique({
          where: { id },
          include: FACTORY_SECTION_INCLUDE,
        })) as FactorySectionWithRelations | null,
      applyDraft: async (id, payload, tx) => {
        if (!payload) {
          const row = await tx.factorySection.findUnique({
            where: { id },
            include: FACTORY_SECTION_INCLUDE,
          });
          if (!row) throw new NotFoundException('Factory section not found.');
          return row as FactorySectionWithRelations;
        }

        const dto = payload as UpdateFactorySectionDto;
        const existing = await tx.factorySection.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException('Factory section not found.');

        if (dto.slug && dto.slug !== existing.slug) {
          const taken = await tx.factorySection.findUnique({
            where: { slug: dto.slug },
            select: { id: true },
          });
          if (taken) throw new ConflictException(`slug 已被占用：${dto.slug}`);
        }

        const { coverMediaId, coverImageUrl } = await this.prepareUpdate(dto, existing, tx);
        return this.applyUpdate(tx, id, dto, coverMediaId, coverImageUrl);
      },
      markPublished: async (id, nextVersion, tx) => {
        const current = await tx.factorySection.findUnique({
          where: { id },
          select: { publishedAt: true },
        });
        return tx.factorySection.update({
          where: { id },
          data: {
            status: ContentStatus.PUBLISHED,
            publishedAt: current?.publishedAt ?? new Date(),
            version: { increment: 1 },
            publishedVersion: nextVersion,
          },
          include: FACTORY_SECTION_INCLUDE,
        }) as Promise<FactorySectionWithRelations>;
      },
      markUnpublished: async (id, tx) =>
        tx.factorySection.update({
          where: { id },
          // 保留内容、publishedAt 与发布历史
          data: { status: ContentStatus.UNPUBLISHED, version: { increment: 1 } },
          include: FACTORY_SECTION_INCLUDE,
        }) as Promise<FactorySectionWithRelations>,
      validate: (row) => {
        requireText(row.title, '标题', '工厂分区');
        requireText(row.slug, 'URL 别名（slug）', '工厂分区');
        if (!row.sectionType) {
          throw new BadRequestException('发布失败：工厂分区必须指定分区类型');
        }
      },
      toSnapshot: (row) => toFactorySectionDetail(row),
    };
  }

  /** 发布状态快照（供控制器决定「直接改行」还是「写编辑稿」） */
  publishState(id: string): Promise<PublishState> {
    return getPublishState(this.prisma, this.publishingAdapter(), id);
  }

  /** 保存编辑稿（已发布分区不再直接改写线上行） */
  saveDraft(
    id: string,
    dto: UpdateFactorySectionDto,
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
  async publish(id: string, actorId: string | null): Promise<FactorySectionDetailDto> {
    const result = await publishEntity(this.prisma, this.publishingAdapter(), id, actorId);
    this.notifyFrontend();
    return withPublishMeta(toFactorySectionDetail(result.row), result);
  }

  /** 取消发布：保留内容与历史，公开侧立即不可见 */
  async unpublish(id: string): Promise<FactorySectionDetailDto> {
    const result = await unpublishEntity(this.prisma, this.publishingAdapter(), id);
    this.notifyFrontend();
    return withPublishMeta(toFactorySectionDetail(result.row), result);
  }

  /** 预览：线上版本 + 编辑稿（仅后台授权访问） */
  preview(id: string) {
    return previewEntity(this.prisma, this.publishingAdapter(), id, (row) =>
      toFactorySectionDetail(row),
    );
  }

  /** 发布历史 */
  revisions(id: string) {
    return listEntityRevisions(this.prisma, this.publishingAdapter(), id);
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  /**
   * 解析更新所需的封面字段并校验所有媒体引用存在。
   * 直接保存与「发布时应用编辑稿」共用，避免两条路径校验不一致。
   */
  private async prepareUpdate(
    dto: UpdateFactorySectionDto,
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

    const mediaIds = [
      ...(dto.images ?? []).map((image) => image.mediaId),
      ...(dto.exhibitions ?? []).flatMap((exhibition) =>
        (exhibition.photos ?? []).map((photo) => photo.mediaId),
      ),
    ];
    const unique = [...new Set(mediaIds)];
    if (unique.length > 0) {
      const found = await db.mediaAsset.findMany({
        where: { id: { in: unique } },
        select: { id: true },
      });
      if (found.length !== unique.length) {
        const foundIds = new Set(found.map((row) => row.id));
        const missing = unique.filter((mediaId) => !foundIds.has(mediaId));
        throw new BadRequestException(`媒体资源不存在：${missing.join(', ')}`);
      }
    }

    return { coverMediaId, coverImageUrl };
  }

  private async assertSectionExists(id: string): Promise<void> {
    const found = await this.prisma.factorySection.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('Factory section not found.');
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    const taken = await this.prisma.factorySection.findUnique({ where: { slug }, select: { id: true } });
    if (taken) throw new ConflictException(`slug 已被占用：${slug}`);
  }

  /** 媒体存在性校验（单一） */
  private async assertMediaExists(mediaId: string): Promise<void> {
    const found = await this.prisma.mediaAsset.findUnique({ where: { id: mediaId }, select: { id: true } });
    if (!found) throw new BadRequestException(`媒体资源不存在：${mediaId}`);
  }

  /** 媒体存在性校验（批量，去重后比对数量） */
  private async assertAllMediaExist(mediaIds: string[]): Promise<void> {
    const unique = [...new Set(mediaIds)];
    if (unique.length === 0) return;
    const found = await this.prisma.mediaAsset.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      const foundIds = new Set(found.map((row) => row.id));
      const missing = unique.filter((mediaId) => !foundIds.has(mediaId));
      throw new BadRequestException(`媒体资源不存在：${missing.join(', ')}`);
    }
  }

  /** 取媒体对外 URL（用于 coverImageUrl 快照回填） */
  private async resolveMediaUrl(mediaId: string): Promise<string | null> {
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { url: true },
    });
    return media?.url ?? null;
  }

  /**
   * 发布时间说明（Phase 1）：
   *   · 发布时间由 publish 动作在服务端写入，不再由调用方传入
   *   · 首次发布 → now；重新发布 → 沿用首次发布时间（避免 SEO 时间线抖动）
   *   · 取消发布 → 保留原值
   */
}

export { FactorySectionType };
