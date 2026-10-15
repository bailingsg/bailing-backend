import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicApplicationsListQueryDto } from './dto/public-list-query.dto';
import {
  toPublicApplicationDetail,
  toPublicApplicationListItem,
} from './entities/public.entity';

const APPLICATION_PUBLIC_INCLUDE = {
  coverMedia: true,
  products: {
    include: {
      product: {
        include: { images: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  },
} satisfies Prisma.ApplicationInclude;

/**
 * 产品应用场景公开只读服务（Phase 4.5）。
 *
 * 发布规则（硬约束）：
 *   · **只返回 status = PUBLISHED** 的应用场景
 *   · 详情内的关联产品只返回 status = PUBLISHED 的产品（产品状态独立判定）
 *   · 不暴露内部字段；未发布场景按 slug 访问一律 404
 */
@Injectable()
export class PublicApplicationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PublicApplicationsListQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(48, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.ApplicationWhereInput = { status: ContentStatus.PUBLISHED };
    if (query.featured === 'true') where.featured = true;
    else if (query.featured === 'false') where.featured = false;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.application.count({ where }),
      this.prisma.application.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map(toPublicApplicationListItem),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** 公开应用场景详情（按 slug） */
  async findBySlug(slug: string) {
    const row = await this.prisma.application.findFirst({
      where: { slug, status: ContentStatus.PUBLISHED },
      include: APPLICATION_PUBLIC_INCLUDE,
    });
    if (!row) throw new NotFoundException('Application not found.');
    return toPublicApplicationDetail(row);
  }
}
