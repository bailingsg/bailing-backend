import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { countRfqByStatus, postStatusSummary, productStatusSummary, type CmsStatsDto } from './cms.dto';
import type { ActorContext } from '../rbac/actor-context';

/**
 * CMS 统计服务：Dashboard 所需的真实业务计数。
 *
 * 数据源全部为 Prisma count / findMany(status)，不引入任何虚构数字。
 *
 * 询盘统计的数据隔离（2026-10-28）：
 *   · 超级管理员 → 全局询盘计数（用于统一跟进与总览）
 *   · 业务 / 销售账号 → 仅统计「分配给本人」的询盘（不展示他人线索）
 * 产品 / 分类 / 文章为内容资产，不做按人隔离。
 */
@Injectable()
export class CmsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Dashboard 统计：询盘、产品、分类、文章 */
  async getStats(actor?: ActorContext): Promise<CmsStatsDto> {
    // 业务 / 销售账号只看分配给自己的询盘；超级管理员看全局
    const rfqWhere: Prisma.RfqWhereInput = {};
    if (actor && !actor.isSuperAdmin) {
      rfqWhere.assigneeId = actor.id;
    }

    const [rfqRows, productRows, categoryCount, blogRows] = await this.prisma.$transaction([
      this.prisma.rfq.findMany({ where: rfqWhere, select: { status: true } }),
      this.prisma.product.findMany({ select: { status: true } }),
      this.prisma.category.count(),
      this.prisma.blogPost.findMany({ select: { status: true } }),
    ]);

    return {
      rfq: countRfqByStatus(rfqRows),
      products: productStatusSummary(productRows),
      categories: categoryCount,
      blogPosts: postStatusSummary(blogRows),
    };
  }
}
