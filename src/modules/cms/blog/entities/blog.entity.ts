import { PostStatus, ProductStatus } from '@prisma/client';
import type {
  AdminUser,
  BlogCategory,
  BlogPost,
  BlogPostProduct,
  BlogPostTag,
  BlogTag,
  MediaAsset,
  Product,
} from '@prisma/client';

/**
 * CMS Blog 对外实体（响应结构）。
 *
 * 与公开站博客 API 相互独立：CMS 需要管理字段（草稿、SEO、OG、标签 ID 列表），
 * 公开站只读已发布内容。
 *
 * 注意：**不返回任何敏感字段**（author 仅含 id/name；coverMedia 不含 storageKey 等内部键）。
 */

/** 博客分类（CMS 视图，含文章计数） */
export interface BlogCategoryDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  postCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 博客标签（CMS 视图，含文章计数） */
export interface BlogTagDto {
  id: string;
  name: string;
  slug: string;
  postCount: number;
  createdAt: string;
}

/** 文章上挂载的标签（精简） */
export interface BlogPostTagRefDto {
  id: string;
  name: string;
  slug: string;
}

/** 文章作者（精简，不暴露 email/role 等） */
export interface BlogAuthorRefDto {
  id: string;
  name: string;
}

/** 文章封面媒体（精简，不暴露 storageKey / createdBy 等内部字段） */
export interface BlogCoverMediaRefDto {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

/** 文章关联产品（精简引用，供后台展示与前台跳转） */
export interface BlogRelatedProductRefDto {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
}

/** 文章列表项 */
export interface BlogPostListItemDto {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  status: PostStatus;
  featured: boolean;
  category: { id: string; name: string; slug: string } | null;
  tags: BlogPostTagRefDto[];
  coverImageUrl: string | null;
  coverMediaId: string | null;
  author: BlogAuthorRefDto | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 文章详情（编辑表单数据源） */
export interface BlogPostDetailDto {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  content: string;
  status: PostStatus;
  featured: boolean;
  categoryId: string | null;
  category: { id: string; name: string; slug: string } | null;
  tagIds: string[];
  tags: BlogPostTagRefDto[];
  /** Phase 5.6：关联产品（最多 4 个，按选择顺序） */
  relatedProductIds: string[];
  relatedProducts: BlogRelatedProductRefDto[];
  coverMediaId: string | null;
  coverImageUrl: string | null;
  coverMedia: BlogCoverMediaRefDto | null;
  author: BlogAuthorRefDto | null;
  publishedAt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 分页信封 */
export interface PaginatedBlogPostsDto {
  items: BlogPostListItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/* ------------------------------- Mapper ------------------------------- */

export type BlogPostWithRelations = BlogPost & {
  category: Pick<BlogCategory, 'id' | 'name' | 'slug'> | null;
  author: Pick<AdminUser, 'id' | 'name'> | null;
  coverMedia: Pick<MediaAsset, 'id' | 'url' | 'altText' | 'width' | 'height'> | null;
  tags: Array<BlogPostTag & { tag: Pick<BlogTag, 'id' | 'name' | 'slug'> }>;
  /** Phase 5.6：关联产品（join 行 + 产品精简字段） */
  relatedProducts: Array<
    BlogPostProduct & { product: Pick<Product, 'id' | 'name' | 'slug' | 'status'> }
  >;
};

function toTagRefs(tags: BlogPostWithRelations['tags']): BlogPostTagRefDto[] {
  return tags
    .map((link) => ({ id: link.tag.id, name: link.tag.name, slug: link.tag.slug }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 关联产品按 sortOrder 升序（sortOrder 即用户选择顺序） */
function toRelatedProductRefs(
  links: BlogPostWithRelations['relatedProducts'],
): BlogRelatedProductRefDto[] {
  return [...links]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.product.name.localeCompare(b.product.name))
    .map((link) => ({
      id: link.product.id,
      name: link.product.name,
      slug: link.product.slug,
      status: link.product.status,
    }));
}

function toCoverRef(media: BlogPostWithRelations['coverMedia']): BlogCoverMediaRefDto | null {
  if (!media) return null;
  return {
    id: media.id,
    url: media.url,
    altText: media.altText,
    width: media.width,
    height: media.height,
  };
}

export function toBlogPostListItem(post: BlogPostWithRelations): BlogPostListItemDto {
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    status: post.status,
    featured: post.featured,
    category: post.category
      ? { id: post.category.id, name: post.category.name, slug: post.category.slug }
      : null,
    tags: toTagRefs(post.tags),
    coverImageUrl: post.coverImageUrl,
    coverMediaId: post.coverMediaId,
    author: post.author ? { id: post.author.id, name: post.author.name } : null,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export function toBlogPostDetail(post: BlogPostWithRelations): BlogPostDetailDto {
  const tags = toTagRefs(post.tags);
  const relatedProducts = toRelatedProductRefs(post.relatedProducts ?? []);
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    content: post.content,
    status: post.status,
    featured: post.featured,
    categoryId: post.categoryId,
    category: post.category
      ? { id: post.category.id, name: post.category.name, slug: post.category.slug }
      : null,
    tagIds: tags.map((t) => t.id),
    tags,
    relatedProductIds: relatedProducts.map((p) => p.id),
    relatedProducts,
    coverMediaId: post.coverMediaId,
    coverImageUrl: post.coverImageUrl,
    coverMedia: toCoverRef(post.coverMedia),
    author: post.author ? { id: post.author.id, name: post.author.name } : null,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    seoKeywords: post.seoKeywords,
    canonicalUrl: post.canonicalUrl,
    ogTitle: post.ogTitle,
    ogDescription: post.ogDescription,
    ogImage: post.ogImage,
    twitterTitle: post.twitterTitle,
    twitterDescription: post.twitterDescription,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

/** 分类 DTO 映射 */
export function toBlogCategoryDto(
  category: BlogCategory,
  postCount: number,
): BlogCategoryDto {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    postCount,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

/** 标签 DTO 映射 */
export function toBlogTagDto(tag: BlogTag, postCount: number): BlogTagDto {
  return {
    id: tag.id,
    name: tag.name,
    slug: tag.slug,
    postCount,
    createdAt: tag.createdAt.toISOString(),
  };
}
