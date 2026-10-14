import { ProductStatus } from '@prisma/client';
import type { Category, Product, ProductImage } from '@prisma/client';

/**
 * CMS Products 对外实体（响应结构）。
 * 与公开产品 API（src/modules/products）的 DTO 相互独立：
 * CMS 需要管理字段（草稿、归档、标签、完整规格），公开站只读已发布内容。
 */

/** 分类（CMS 视图，含产品计数） */
export interface CmsCategoryDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 产品图片 */
export interface CmsProductImageDto {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
  createdAt: string;
}

/** 产品列表项 */
export interface CmsProductListItemDto {
  id: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  status: ProductStatus;
  isFeatured: boolean;
  category: { id: string; name: string; slug: string } | null;
  primaryImage: CmsProductImageDto | null;
  imageCount: number;
  updatedAt: string;
}

/** 产品详情（编辑表单数据源） */
export interface CmsProductDetailDto {
  id: string;
  name: string;
  slug: string;
  categoryId: string | null;
  shortDescription: string | null;
  description: string;
  material: string | null;
  application: string | null;
  applications: string[];
  specifications: Record<string, string> | null;
  status: ProductStatus;
  isFeatured: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  images: CmsProductImageDto[];
  createdAt: string;
  updatedAt: string;
}

/** 分页信封 */
export interface PaginatedCmsProductsDto {
  items: CmsProductListItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/* ------------------------------- Mapper ------------------------------- */

export type ProductWithRelations = Product & {
  category: Pick<Category, 'id' | 'name' | 'slug'> | null;
  images: ProductImage[];
};

/** JSON 规格 → Record<string,string>；非法结构降级 null */
export function normalizeSpecifications(
  value: unknown,
): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, typeof v === 'string' ? v : String(v)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** JSON 应用标签 → string[]；过滤非字符串项 */
export function normalizeApplications(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

function toImageDto(image: ProductImage): CmsProductImageDto {
  return {
    id: image.id,
    url: image.url,
    altText: image.altText,
    sortOrder: image.sortOrder,
    isPrimary: image.isPrimary,
    createdAt: image.createdAt.toISOString(),
  };
}

/** 图片排序：主图优先 → sortOrder → 创建时间 */
export function sortImages(images: ProductImage[]): CmsProductImageDto[] {
  return [...images]
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })
    .map(toImageDto);
}

export function toCmsProductListItem(product: ProductWithRelations): CmsProductListItemDto {
  const images = sortImages(product.images);
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    shortDescription: product.shortDescription,
    status: product.status,
    isFeatured: product.isFeatured,
    category: product.category
      ? { id: product.category.id, name: product.category.name, slug: product.category.slug }
      : null,
    primaryImage: images[0] ?? null,
    imageCount: product.images.length,
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function toCmsProductDetail(product: ProductWithRelations): CmsProductDetailDto {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    categoryId: product.categoryId,
    shortDescription: product.shortDescription,
    description: product.description,
    material: product.material,
    application: product.application,
    applications: normalizeApplications(product.applications),
    specifications: normalizeSpecifications(product.specifications),
    status: product.status,
    isFeatured: product.isFeatured,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    images: sortImages(product.images),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
