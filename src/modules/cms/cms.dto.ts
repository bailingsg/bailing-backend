import { PostStatus, ProductStatus, RfqStatus } from '@prisma/client';
import type { BlogPost, Product, Rfq } from '@prisma/client';

/**
 * GET /api/v1/cms/stats 响应。
 * 全部为数据库真实计数；占位/演示数据一律不得进入该结构。
 */
export interface CmsStatsDto {
  rfq: {
    total: number;
    byStatus: Record<RfqStatus, number>;
  };
  products: {
    total: number;
    published: number;
    draft: number;
  };
  categories: number;
  blogPosts: {
    total: number;
    published: number;
    draft: number;
  };
}

/** RFQ 状态分布（含全量 total） */
export function countRfqByStatus(rows: Pick<Rfq, 'status'>[]): CmsStatsDto['rfq'] {
  const byStatus: Record<RfqStatus, number> = {
    [RfqStatus.NEW]: 0,
    [RfqStatus.CONTACTED]: 0,
    [RfqStatus.QUOTED]: 0,
    [RfqStatus.CLOSED]: 0,
  };
  for (const row of rows) byStatus[row.status] += 1;
  return { total: rows.length, byStatus };
}

/** 产品状态分布（total / published / draft） */
export function productStatusSummary(rows: Pick<Product, 'status'>[]): CmsStatsDto['products'] {
  let published = 0;
  let draft = 0;
  for (const row of rows) {
    if (row.status === ProductStatus.PUBLISHED) published += 1;
    else if (row.status === ProductStatus.DRAFT) draft += 1;
  }
  return { total: rows.length, published, draft };
}

/** 文章状态分布（total / published / draft） */
export function postStatusSummary(rows: Pick<BlogPost, 'status'>[]): CmsStatsDto['blogPosts'] {
  let published = 0;
  let draft = 0;
  for (const row of rows) {
    if (row.status === PostStatus.PUBLISHED) published += 1;
    else if (row.status === PostStatus.DRAFT) draft += 1;
  }
  return { total: rows.length, published, draft };
}
