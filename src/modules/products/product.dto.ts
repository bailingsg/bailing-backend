import { Prisma } from '@prisma/client';

/**
 * 产品 API 的对外契约（DTO）。
 *
 * 这些结构是**稳定的公开契约**：前端、未来的 CMS、第三方集成都依赖它。
 * 因此数据库字段变化不应直接泄漏到响应中，统一经 mapper 转换。
 *
 * 注意：本产品线为 B2B 制造与出口业务，**不包含** price / stock / sku /
 * rating / review 等电商字段（百灵木业不做在线零售）。
 */

export interface ProductImageDto {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
}

export interface ProductCategoryRefDto {
  id: string;
  slug: string;
  name: string;
}

/** 列表项：用于产品网格卡片 */
export interface ProductListItemDto {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  category: ProductCategoryRefDto | null;
  material: string | null;
  application: string | null;
  /**
   * 应用标签（后台 CMS「应用标签」维护，最多 20 项）。
   * 未配置 / 非法结构一律为 null（不伪造标签）。
   */
  applications: string[] | null;
  featured: boolean;
  images: ProductImageDto[];
}

/** 详情：/products/:slug 完整信息 */
export interface ProductDetailDto extends ProductListItemDto {
  description: string;
  /** 规格参数键值对；未配置时为 null（不伪造规格） */
  specifications: Record<string, string> | null;
  seo: {
    title: string;
    description: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

/** 分页信封 */
export interface PaginatedProductsDto {
  items: ProductListItemDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { category: true; images: true };
}>;

/** jsonb 规格字段 → 稳定的 Record<string,string>；非法结构一律降级为 null */
export function normalizeSpecifications(
  value: Prisma.JsonValue | null,
): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, typeof v === 'string' ? v : String(v)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * jsonb 应用标签 → 稳定的 string[]；非数组 / 空数组 / 非法项一律降级为 null。
 *
 * 后台字段是自由输入的标签（TagInput），历史上可能出现非字符串项或空白项，
 * 这里统一清洗，保证公开契约里只出现非空字符串。
 */
export function normalizeApplications(value: Prisma.JsonValue | null): string[] | null {
  if (!value || !Array.isArray(value)) return null;
  const tags = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return tags.length > 0 ? tags : null;
}

function toImageDto(image: ProductWithRelations['images'][number]): ProductImageDto {
  return {
    id: image.id,
    url: image.url,
    altText: image.altText,
    sortOrder: image.sortOrder,
    isPrimary: image.isPrimary,
  };
}

/** 图片排序：主图优先，其次按 sortOrder */
function sortImages(images: ProductWithRelations['images']): ProductImageDto[] {
  return [...images]
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })
    .map(toImageDto);
}

export function toProductListItem(product: ProductWithRelations): ProductListItemDto {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    shortDescription: product.shortDescription,
    category: product.category
      ? { id: product.category.id, slug: product.category.slug, name: product.category.name }
      : null,
    material: product.material,
    application: product.application,
    applications: normalizeApplications(product.applications),
    featured: product.isFeatured,
    images: sortImages(product.images),
  };
}

export function toProductDetail(product: ProductWithRelations): ProductDetailDto {
  return {
    ...toProductListItem(product),
    description: product.description,
    specifications: normalizeSpecifications(product.specifications),
    seo: {
      title: product.seoTitle ?? product.name,
      description: product.seoDescription ?? product.shortDescription ?? null,
    },
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
