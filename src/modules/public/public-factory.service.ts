import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentStatus, FactorySectionType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicFactoryListQueryDto } from './dto/public-list-query.dto';
import {
  toPublicFactoryDetail,
  toPublicFactoryListItem,
} from './entities/public.entity';

const PUBLIC_INCLUDE = {
  coverMedia: true,
  images: { include: { media: true } },
  exhibitions: { include: { photos: { include: { media: true } } } },
} satisfies Prisma.FactorySectionInclude;

/**
 * 工厂实力公开只读服务（Phase 4.5）。
 *
 * 发布规则（硬约束）：
 *   · **只返回 status = PUBLISHED** 的分区，草稿/下架内容在查询条件即被过滤
 *   · 展会照片只返回 isVisible = true 的展会
 *   · 响应不含 storageKey / createdBy / provider / status / sortOrder 等内部字段
 */
@Injectable()
export class PublicFactoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** 公开分区列表 */
  async list(query: PublicFactoryListQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(48, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.FactorySectionWhereInput = { status: ContentStatus.PUBLISHED };
    if (query.sectionType && isFactorySectionType(query.sectionType)) {
      where.sectionType = query.sectionType;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.factorySection.count({ where }),
      this.prisma.factorySection.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map(toPublicFactoryListItem),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** 公开分区详情（按 slug）——非 PUBLISHED 一律 404，不泄漏存在性 */
  async findBySlug(slug: string) {
    const row = await this.prisma.factorySection.findFirst({
      where: { slug, status: ContentStatus.PUBLISHED },
      include: PUBLIC_INCLUDE,
    });
    if (!row) throw new NotFoundException('Factory section not found.');
    return toPublicFactoryDetail(row);
  }
}

function isFactorySectionType(value: string): value is FactorySectionType {
  return (Object.values(FactorySectionType) as string[]).includes(value);
}
