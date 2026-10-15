import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentStatus, FactorySectionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sanitizeRichText } from '../blog/rich-text.sanitizer';
import {
  CreateFactorySectionDto,
  FactoryExhibitionItemDto,
  UpdateFactorySectionDto,
} from './dto/factory-section.dto';
import { ListFactorySectionsQueryDto } from './dto/list-factory-sections-query.dto';
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
  constructor(private readonly prisma: PrismaService) {}

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

    const status = dto.status ?? ContentStatus.DRAFT;
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
          status,
          sortOrder: dto.sortOrder ?? 0,
          publishedAt: this.resolvePublishedAt(status, dto.publishedAt ?? null),
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

    return toFactorySectionDetail(created as FactorySectionWithRelations);
  }

  /* ------------------------------ 更新 ------------------------------ */

  async update(id: string, dto: UpdateFactorySectionDto): Promise<FactorySectionDetailDto> {
    const existing = await this.prisma.factorySection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Factory section not found.');

    if (dto.slug && dto.slug !== existing.slug) {
      await this.assertSlugAvailable(dto.slug);
    }

    // coverMediaId：undefined = 不改动；null = 清空；字符串 = 换封面
    let coverMediaId = existing.coverMediaId;
    let coverImageUrl = existing.coverImageUrl;
    if (dto.coverMediaId !== undefined) {
      if (dto.coverMediaId === null) {
        coverMediaId = null;
        coverImageUrl = null;
      } else {
        await this.assertMediaExists(dto.coverMediaId);
        coverMediaId = dto.coverMediaId;
        coverImageUrl = await this.resolveMediaUrl(dto.coverMediaId);
      }
    }

    const status = dto.status ?? existing.status;

    if (dto.images !== undefined) {
      await this.assertAllMediaExist(dto.images.map((image) => image.mediaId));
    }
    if (dto.exhibitions !== undefined) {
      await this.assertAllMediaExist(
        dto.exhibitions.flatMap((exhibition) => (exhibition.photos ?? []).map((photo) => photo.mediaId)),
      );
    }

    await this.prisma.$transaction(async (tx) => {
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
          status,
          publishedAt: this.resolvePublishedAt(status, dto.publishedAt ?? existing.publishedAt, existing.publishedAt),
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
    });

    return this.findById(id);
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

    await this.prisma.factorySection.delete({ where: { id } });
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

  /* ------------------------------ 内部工具 ------------------------------ */

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
   * 发布时间的确定规则：
   *   · 显式传入值 → 采用
   *   · 状态为 PUBLISHED 且当前无值 → 回填 now
   *   · 状态为 DRAFT → 保留既有值（不因撤回而丢失历史发布时间）
   */
  private resolvePublishedAt(
    status: ContentStatus,
    incoming: string | Date | null,
    existing: Date | null = null,
  ): Date | null {
    if (incoming) return new Date(incoming);
    if (status === ContentStatus.PUBLISHED) return existing ?? new Date();
    return existing;
  }
}

export { FactorySectionType };
