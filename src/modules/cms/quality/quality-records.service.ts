import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateQualityRecordDto,
  UpdateQualityRecordDto,
} from './dto/quality-record.dto';
import { ListQualityRecordsQueryDto } from './dto/list-quality-records-query.dto';
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
  constructor(private readonly prisma: PrismaService) {}

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

    const status = dto.status ?? ContentStatus.DRAFT;
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
        status,
        sortOrder: dto.sortOrder ?? 0,
        publishedAt: this.resolvePublishedAt(status, dto.publishedAt ?? null),
        seoTitle: dto.seoTitle ?? null,
        seoDescription: dto.seoDescription ?? null,
      },
      include: QUALITY_RECORD_INCLUDE,
    });

    return toQualityRecordDetail(created as QualityRecordWithRelations);
  }

  /* ------------------------------ 更新 ------------------------------ */

  async update(id: string, dto: UpdateQualityRecordDto): Promise<QualityRecordDetailDto> {
    const existing = await this.prisma.qualityRecord.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Quality record not found.');

    if (dto.slug && dto.slug !== existing.slug) {
      await this.assertSlugAvailable(dto.slug);
    }

    // mediaId：undefined = 不改动；null = 解除关联；字符串 = 换文件
    let mediaId = existing.mediaId;
    if (dto.mediaId !== undefined) {
      if (dto.mediaId === null) {
        mediaId = null;
      } else {
        await this.assertMediaExists(dto.mediaId);
        mediaId = dto.mediaId;
      }
    }

    const status = dto.status ?? existing.status;

    await this.prisma.qualityRecord.update({
      where: { id },
      data: {
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
        status,
        publishedAt: this.resolvePublishedAt(status, dto.publishedAt, existing.publishedAt),
      },
      include: QUALITY_RECORD_INCLUDE,
    });

    return this.findById(id);
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

    await this.prisma.qualityRecord.delete({ where: { id } });
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
   * 发布时间的生成规则：
   *   · 显式传入 publishedAt → 采用
   *   · 置为 PUBLISHED 且从未发布过 → 记录当前时间
   *   · 置为 DRAFT → **保留历史 publishedAt**（重新发布时不重置首发时间）
   */
  private resolvePublishedAt(
    status: ContentStatus,
    incoming: string | Date | null | undefined,
    existing: Date | null = null,
  ): Date | null {
    if (incoming) return new Date(incoming);
    if (status === ContentStatus.PUBLISHED) return existing ?? new Date();
    return existing;
  }
}

/** 可空文本归一：undefined 原样返回；空串 → null；其余 trim 后返回 */
function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
