import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { countRfqByStatus, postStatusSummary, productStatusSummary, type CmsStatsDto } from './cms.dto';

/**
 * CMS 统计服务：Dashboard 所需的真实业务计数。
 *
 * 数据源全部为 Prisma count / findMany(status)，不引入任何虚构数字。
 */
@Injectable()
export class CmsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Dashboard 统计：询盘、产品、分类、文章 */
  async getStats(): Promise<CmsStatsDto> {
    const [rfqRows, productRows, categoryCount, blogRows] = await this.prisma.$transaction([
      this.prisma.rfq.findMany({ select: { status: true } }),
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
