import { Injectable } from '@nestjs/common';
import { ContentStatus, Prisma, QualityRecordType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicQualityListQueryDto } from './dto/public-list-query.dto';
import { toPublicQualityRecord } from './entities/public.entity';

/**
 * 质量体系公开只读服务（Phase 4.5）。
 *
 * 发布规则（硬约束）：
 *   · **只返回 status = PUBLISHED** 的记录，草稿/下架内容一律不出现在公开响应
 *   · 未发布记录即使同时存在于业务库也**不得**被公开接口读到
 *   · 到期结论只在真实 expiryDate 存在时给出（isExpired = null 表示数据缺失，非「未过期」）
 */
@Injectable()
export class PublicQualityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PublicQualityListQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(48, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.QualityRecordWhereInput = { status: ContentStatus.PUBLISHED };
    if (query.recordType && isQualityRecordType(query.recordType)) {
      where.recordType = query.recordType;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.qualityRecord.count({ where }),
      this.prisma.qualityRecord.findMany({
        where,
        include: { media: true },
        orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map(toPublicQualityRecord),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}

function isQualityRecordType(value: string): value is QualityRecordType {
  return (Object.values(QualityRecordType) as string[]).includes(value);
}
