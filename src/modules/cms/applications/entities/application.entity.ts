import type { Application, ApplicationProduct, MediaAsset, Product } from '@prisma/client';

/**
 * Applications CMS 对外实体（响应结构）。
 *
 * 安全约定：coverMedia 一律**不返回 storageKey、createdBy、provider** 等内部字段；
 * 关联产品只暴露公开可用的展示字段（id/name/slug/status），不泄漏后台内部数据。
 */

/** 应用场景封面所引用的媒体（精简视图） */
export interface ApplicationMediaRefDto {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
}

/** 关联产品的精简视图 */
export interface ApplicationProductRefDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  /** 关联排序（应用场景内的展示顺序） */
  sortOrder: number;
}

/** 应用场景列表项 */
export interface ApplicationListItemDto {
  id: string;
  name: string;
  slug: string;
  summary: string | null;
  status: string;
  featured: boolean;
  sortOrder: number;
  coverImageUrl: string | null;
  coverMediaId: string | null;
  coverMedia: ApplicationMediaRefDto | null;
  productCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 应用场景详情（含描述、关联产品、SEO） */
export interface ApplicationDetailDto extends ApplicationListItemDto {
  description: string | null;
  products: ApplicationProductRefDto[];
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface PaginatedApplicationsDto {
  items: ApplicationListItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/* ------------------------------ 关联类型 ------------------------------ */

export type ApplicationWithRelations = Application & {
  coverMedia: MediaAsset | null;
  products: (ApplicationProduct & { product: Product })[];
  _count?: { products: number };
};

/* ------------------------------ 映射器 ------------------------------ */

function toMediaRef(media: MediaAsset | null): ApplicationMediaRefDto | null {
  if (!media) return null;
  return {
    id: media.id,
    url: media.url,
    altText: media.altText,
    width: media.width,
    height: media.height,
    mimeType: media.mimeType,
  };
}

function toProductRef(row: ApplicationProduct & { product: Product }): ApplicationProductRefDto {
  return {
    id: row.product.id,
    name: row.product.name,
    slug: row.product.slug,
    status: row.product.status,
    sortOrder: row.sortOrder,
  };
}

export function toApplicationListItem(row: ApplicationWithRelations): ApplicationListItemDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    summary: row.summary,
    status: row.status,
    featured: row.featured,
    sortOrder: row.sortOrder,
    coverImageUrl: row.coverImageUrl,
    coverMediaId: row.coverMediaId,
    coverMedia: toMediaRef(row.coverMedia),
    productCount: row._count?.products ?? row.products.length,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toApplicationDetail(row: ApplicationWithRelations): ApplicationDetailDto {
  const base = toApplicationListItem(row);
  return {
    ...base,
    description: row.description,
    products: row.products
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.productId.localeCompare(b.productId))
      .map(toProductRef),
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}
