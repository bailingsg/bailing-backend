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
  CreateQualityRecordDto,
  UpdateQualityRecordDto,
} from './dto/quality-record.dto';
import { ListQualityRecordsQueryDto } from './dto/list-quality-records-query.dto';
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
  toQualityRecordDetail,
  toQualityRecordListItem,
  type PaginatedQualityRecordsDto,
  type QualityRecordDetailDto,
  type QualityRecordWithRelations,
} from './entities/quality.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

const QUALITY_RECORD_INCLUDE = {
  media: true,
} satisfies Prisma.QualityRecordInclude;

/**
 * 质量体系 CMS 服务（Phase 4.5）。
 *
 * 安全与一致性要点：
 *   · description 为纯文本展示字段，前端按文本渲染（不做富文本，避免 XSS 面）
 *   · mediaId 先做**存在性校验**，返回 400 而非外键异常
 *   · 证书文件一律引用 Media Library 资产——本模块**不允许**自行上传文件
 *   · 删除记录只断开关联，**绝不删除 MediaAsset 本身**
 *
 * 数据诚实原则（业务红线）：
 *   · issuer / certificateNumber / issueDate / expiryDate 均可为空，原样保留 null
 *   · **不得**在读取或写入时补占位值、推断值或默认有效期
 *   · 到期判断只在公开 API 侧基于真实 expiryDate 计算，缺失即不做任何过期结论
 */
@Injectable()
export class QualityRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  /** 质量记录变更后通知前台失效（质量页展示已发布认证与报告） */
  private notifyFrontend(): void {
    void this.revalidation.invalidate({
      tags: [CmsTags.quality],
      paths: ['/quality'],
    });
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 记录列表：分页 + keyword / recordType / status 筛选 */
  async list(query: ListQualityRecordsQueryDto): Promise<PaginatedQualityRecordsDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.QualityRecordWhereInput = {};
    if (query.recordType) where.recordType = query.recordType;
    if (query.status) where.status = query.status;
    if (query.keyword) {
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { slug: { contains: query.keyword, mode: 'insensitive' } },
        { issuer: { contains: query.keyword, mode: 'insensitive' } },
        { certificateNumber: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.qualityRecord.count({ where }),
      this.prisma.qualityRecord.findMany({
        where,
        include: QUALITY_RECORD_INCLUDE,
        orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: (rows as QualityRecordWithRelations[]).map(toQualityRecordListItem),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 详情 */
  async findById(id: string): Promise<QualityRecordDetailDto> {
    const row = await this.prisma.qualityRecord.findUnique({
      where: { id },
      include: QUALITY_RECORD_INCLUDE,
    });
    if (!row) throw new NotFoundException('Quality record not found.');
    return toQualityRecordDetail(row as QualityRecordWithRelations);
  }

  /* ------------------------------ 创建 ------------------------------ */

  async create(dto: CreateQualityRecordDto): Promise<QualityRecordDetailDto> {
    await this.assertSlugAvailable(dto.slug);

    const mediaId = dto.mediaId ?? null;
    if (mediaId) await this.assertMediaExists(mediaId);

    const created = await this.prisma.qualityRecord.create({
      data: {
        title: dto.title,
        slug: dto.slug,
        recordType: dto.recordType,
        issuer: dto.issuer ?? null,
        certificateNumber: dto.certificateNumber ?? null,
        issueDate: dto.issueDate ? new Date(dto.issueDate) : null,
        expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
        description: dto.description ?? null,
        mediaId,
        // Phase 1：创建一律为草稿，发布只能经独立 publish 动作
        status: ContentStatus.DRAFT,
        sortOrder: dto.sortOrder ?? 0,
        publishedAt: null,
        seoTitle: dto.seoTitle ?? null,
        seoDescription: dto.seoDescription ?? null,
      },
      include: QUALITY_RECORD_INCLUDE,
    });

    this.notifyFrontend();
    return toQualityRecordDetail(created as QualityRecordWithRelations);
  }

  /* ------------------------------ 更新 ------------------------------ */

  /** 构造更新数据（直接保存与「发布时应用编辑稿」共用） */
  private async buildUpdateData(
    dto: UpdateQualityRecordDto,
    existing: { mediaId: string | null },
    db: PrismaService | Prisma.TransactionClient,
  ): Promise<Prisma.QualityRecordUncheckedUpdateInput> {
    // mediaId：undefined = 不改动；null = 解除关联；字符串 = 换文件
    let mediaId = existing.mediaId;
    if (dto.mediaId !== undefined) {
      if (dto.mediaId === null) {
        mediaId = null;
      } else {
        const found = await db.mediaAsset.findUnique({
          where: { id: dto.mediaId },
          select: { id: true },
        });
        if (!found) throw new BadRequestException(`媒体资源不存在：${dto.mediaId}`);
        mediaId = dto.mediaId;
      }
    }

    return {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
      ...(dto.recordType !== undefined ? { recordType: dto.recordType } : {}),
      // 可空文本字段：显式 null 清空，空串视为清空（DTO trim 后为 ''）；undefined 不改动
      ...(dto.issuer !== undefined ? { issuer: normalizeOptionalText(dto.issuer) } : {}),
      ...(dto.certificateNumber !== undefined
        ? { certificateNumber: normalizeOptionalText(dto.certificateNumber) }
        : {}),
      // 日期字段：显式 null 清空；undefined 不改动。绝不用「缺失」覆盖真实值
      ...(dto.issueDate !== undefined
        ? { issueDate: dto.issueDate ? new Date(dto.issueDate) : null }
        : {}),
      ...(dto.expiryDate !== undefined
        ? { expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null }
        : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      ...(dto.seoTitle !== undefined ? { seoTitle: dto.seoTitle } : {}),
      ...(dto.seoDescription !== undefined ? { seoDescription: dto.seoDescription } : {}),
      mediaId,
      // status / publishedAt 不在 DTO 中，此处不触碰
    };
  }

  async update(
    id: string,
    dto: UpdateQualityRecordDto,
    ctx: { tx?: Prisma.TransactionClient; skipNotify?: boolean } = {},
  ): Promise<QualityRecordDetailDto> {
    const existing = await this.prisma.qualityRecord.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Quality record not found.');

    if (dto.slug && dto.slug !== existing.slug) {
      await this.assertSlugAvailable(dto.slug);
    }

    const db = ctx.tx ?? this.prisma;
    const data = await this.buildUpdateData(dto, existing, db);
    const row = await db.qualityRecord.update({
      where: { id },
      data,
      include: QUALITY_RECORD_INCLUDE,
    });

    if (!ctx.skipNotify) this.notifyFrontend();
    return toQualityRecordDetail(row as QualityRecordWithRelations);
  }

  /* --------------------------- 发布工作流 --------------------------- */

  /**
   * 发布适配器：把质量体系模块接入通用引擎。
   *
   * 发布完整性校验：title / slug 非空、recordType 合法。
   * 证书编号 / 签发机构 / 有效期**允许为空**（数据诚实原则），不阻断发布。
   */
  private publishingAdapter(): PublishAdapter<QualityRecordWithRelations> {
    return {
      entityType: 'QUALITY_RECORD',
      label: '质量记录',
      findRow: async (id) =>
        (await this.prisma.qualityRecord.findUnique({
          where: { id },
          include: QUALITY_RECORD_INCLUDE,
        })) as QualityRecordWithRelations | null,
      applyDraft: async (id, payload, tx) => {
        if (!payload) {
          const row = await tx.qualityRecord.findUnique({
            where: { id },
            include: QUALITY_RECORD_INCLUDE,
          });
          if (!row) throw new NotFoundException('Quality record not found.');
          return row as QualityRecordWithRelations;
        }

        const dto = payload as UpdateQualityRecordDto;
        const existing = await tx.qualityRecord.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException('Quality record not found.');

        if (dto.slug && dto.slug !== existing.slug) {
          const taken = await tx.qualityRecord.findUnique({
            where: { slug: dto.slug },
            select: { id: true },
          });
          if (taken) throw new ConflictException(`slug 已被占用：${dto.slug}`);
        }

        const data = await this.buildUpdateData(dto, existing, tx);
        return tx.qualityRecord.update({
          where: { id },
          data,
          include: QUALITY_RECORD_INCLUDE,
        }) as Promise<QualityRecordWithRelations>;
      },
      markPublished: async (id, nextVersion, tx) => {
        const current = await tx.qualityRecord.findUnique({
          where: { id },
          select: { publishedAt: true },
        });
        return tx.qualityRecord.update({
          where: { id },
          data: {
            status: ContentStatus.PUBLISHED,
            publishedAt: current?.publishedAt ?? new Date(),
            version: { increment: 1 },
            publishedVersion: nextVersion,
          },
          include: QUALITY_RECORD_INCLUDE,
        }) as Promise<QualityRecordWithRelations>;
      },
      markUnpublished: async (id, tx) =>
        tx.qualityRecord.update({
          where: { id },
          // 保留内容、publishedAt 与发布历史
          data: { status: ContentStatus.UNPUBLISHED, version: { increment: 1 } },
          include: QUALITY_RECORD_INCLUDE,
        }) as Promise<QualityRecordWithRelations>,
      validate: (row) => {
        requireText(row.title, '标题', '质量记录');
        requireText(row.slug, 'URL 别名（slug）', '质量记录');
        if (!row.recordType) {
          throw new BadRequestException('发布失败：质量记录必须指定记录类型');
        }
      },
      toSnapshot: (row) => toQualityRecordDetail(row),
    };
  }

  /** 发布状态快照（供控制器决定「直接改行」还是「写编辑稿」） */
  publishState(id: string): Promise<PublishState> {
    return getPublishState(this.prisma, this.publishingAdapter(), id);
  }

  /** 保存编辑稿（已发布记录不再直接改写线上行） */
  saveDraft(
    id: string,
    dto: UpdateQualityRecordDto,
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
  async publish(id: string, actorId: string | null): Promise<QualityRecordDetailDto> {
    const result = await publishEntity(this.prisma, this.publishingAdapter(), id, actorId);
    this.notifyFrontend();
    return withPublishMeta(toQualityRecordDetail(result.row), result);
  }

  /** 取消发布：保留内容与历史，公开侧立即不可见 */
  async unpublish(id: string): Promise<QualityRecordDetailDto> {
    const result = await unpublishEntity(this.prisma, this.publishingAdapter(), id);
    this.notifyFrontend();
    return withPublishMeta(toQualityRecordDetail(result.row), result);
  }

  /** 预览：线上版本 + 编辑稿（仅后台授权访问） */
  preview(id: string) {
    return previewEntity(this.prisma, this.publishingAdapter(), id, (row) =>
      toQualityRecordDetail(row),
    );
  }

  /** 发布历史 */
  revisions(id: string) {
    return listEntityRevisions(this.prisma, this.publishingAdapter(), id);
  }

  /* ------------------------------ 删除 ------------------------------ */

  /**
   * 删除质量记录。
   *
   * 仅删除记录本身；mediaId 关系为 SetNull，**不删除 MediaAsset**——
   * 媒体可否删除由 MediaService 的引用检查独立判定。
   */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.qualityRecord.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Quality record not found.');

    await this.prisma.$transaction([
      // 通用发布表按 entityType+entityId 关联，无外键 → 随主体一并清理
      this.prisma.contentDraft.deleteMany({ where: { entityType: 'QUALITY_RECORD', entityId: id } }),
      this.prisma.contentRevision.deleteMany({
        where: { entityType: 'QUALITY_RECORD', entityId: id },
      }),
      this.prisma.qualityRecord.delete({ where: { id } }),
    ]);
    this.notifyFrontend();
    return { id };
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  private async assertSlugAvailable(slug: string): Promise<void> {
    const taken = await this.prisma.qualityRecord.findUnique({
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

  /**
   * 发布时间说明（Phase 1）：
   *   · 发布时间由 publish 动作在服务端写入，不再由调用方传入
   *   · 首次发布 → now；重新发布 → 沿用首次发布时间
   *   · 取消发布 → 保留原值（数据诚实：不因下架丢失真实首发时间）
   */
}

/** 可空文本归一：undefined 原样返回；空串 → null；其余 trim 后返回 */
function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
