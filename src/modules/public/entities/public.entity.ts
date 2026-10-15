import type {
  FactoryExhibition,
  FactoryImage,
  FactorySection,
  MediaAsset,
  QualityRecord,
  ApplicationProduct,
  Product,
  Application,
} from '@prisma/client';

/**
 * 公开只读 API 的响应映射（Phase 4.5）。
 *
 * 安全原则（发布规则）：
 *   · 只返回 PUBLISHED 内容——草稿、下架内容由 Service 层在查询条件中过滤掉
 *   · **绝不**返回 storageKey / createdBy / provider / status / sortOrder 等内部字段
 *   · 不暴露服务器真实磁盘路径
 *   · 非公开证书（未发布 / 未归类为公开）不进入任何响应
 */

const isDocumentMime = (mimeType: string | null | undefined): boolean =>
  mimeType === 'application/pdf';

/** 公开媒体引用（精简，无内部键） */
export interface PublicMediaRef {
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
  isDocument: boolean;
}

function toPublicMediaRef(media: MediaAsset | null): PublicMediaRef | null {
  if (!media) return null;
  return {
    url: media.url,
    altText: media.altText,
    width: media.width,
    height: media.height,
    mimeType: media.mimeType,
    isDocument: isDocumentMime(media.mimeType),
  };
}

/* ============================== Factory ============================== */

export interface PublicFactoryImage {
  url: string;
  altText: string | null;
}

export interface PublicFactoryExhibition {
  name: string;
  heldOn: string | null;
  location: string | null;
  description: string | null;
  photos: PublicFactoryImage[];
}

export interface PublicFactorySectionListItem {
  title: string;
  slug: string;
  sectionType: string;
  summary: string | null;
  coverImageUrl: string | null;
  publishedAt: string | null;
}

export interface PublicFactorySectionDetail extends PublicFactorySectionListItem {
  content: string | null;
  gallery: PublicFactoryImage[];
  exhibitions: PublicFactoryExhibition[];
  seoTitle: string | null;
  seoDescription: string | null;
}

type FactorySectionPublicRow = FactorySection & {
  coverMedia: MediaAsset | null;
  images: (FactoryImage & { media: MediaAsset | null })[];
  exhibitions: (FactoryExhibition & { photos: (FactoryImage & { media: MediaAsset | null })[] })[];
};

function toPublicFactoryImage(row: FactoryImage & { media: MediaAsset | null }): PublicFactoryImage {
  return { url: row.media?.url ?? '', altText: row.altText ?? row.media?.altText ?? null };
}

export function toPublicFactoryListItem(row: FactorySection): PublicFactorySectionListItem {
  return {
    title: row.title,
    slug: row.slug,
    sectionType: row.sectionType,
    summary: row.summary,
    coverImageUrl: row.coverImageUrl,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

export function toPublicFactoryDetail(row: FactorySectionPublicRow): PublicFactorySectionDetail {
  return {
    title: row.title,
    slug: row.slug,
    sectionType: row.sectionType,
    summary: row.summary,
    coverImageUrl: row.coverImageUrl,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    content: row.content,
    // 公开详情只返回图库（不属于展会的图）与可见展会
    gallery: row.images
      .filter((image) => image.exhibitionId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map(toPublicFactoryImage),
    exhibitions: row.exhibitions
      .filter((exhibition) => exhibition.isVisible)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((exhibition) => ({
        name: exhibition.name,
        heldOn: exhibition.heldOn ? exhibition.heldOn.toISOString() : null,
        location: exhibition.location,
        description: exhibition.description,
        photos: exhibition.photos
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
          .map(toPublicFactoryImage),
      })),
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}

/* ============================== Quality ============================== */

export interface PublicQualityRecord {
  title: string;
  slug: string;
  recordType: string;
  issuer: string | null;
  certificateNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  description: string | null;
  /** 是否已过期——仅在存在真实 expiryDate 时给出结论，缺失则为 null */
  isExpired: boolean | null;
  file: PublicMediaRef | null;
  publishedAt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

/**
 * 到期判定：**只依据真实 expiryDate**。
 * expiryDate 缺失 → 返回 null（不做任何过期推断，也不默认不过期）。
 */
function computeIsExpired(expiryDate: Date | null, now: Date): boolean | null {
  if (!expiryDate) return null;
  return expiryDate.getTime() < now.getTime();
}

export function toPublicQualityRecord(row: QualityRecord & { media: MediaAsset | null }): PublicQualityRecord {
  const now = new Date();
  return {
    title: row.title,
    slug: row.slug,
    recordType: row.recordType,
    issuer: row.issuer,
    certificateNumber: row.certificateNumber,
    issueDate: row.issueDate ? row.issueDate.toISOString() : null,
    expiryDate: row.expiryDate ? row.expiryDate.toISOString() : null,
    description: row.description,
    isExpired: computeIsExpired(row.expiryDate, now),
    file: toPublicMediaRef(row.media),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}

/* ============================== Applications ============================== */

export interface PublicApplicationProduct {
  name: string;
  slug: string;
  shortDescription: string | null;
  coverImageUrl: string | null;
}

export interface PublicApplicationListItem {
  name: string;
  slug: string;
  summary: string | null;
  coverImageUrl: string | null;
  featured: boolean;
  publishedAt: string | null;
}

export interface PublicApplicationDetail extends PublicApplicationListItem {
  description: string | null;
  products: PublicApplicationProduct[];
  seoTitle: string | null;
  seoDescription: string | null;
}

type ApplicationPublicRow = Application & {
  coverMedia: MediaAsset | null;
  products: (ApplicationProduct & {
    product: Product & { images: { url: string; isPrimary: boolean; sortOrder: number }[] };
  })[];
};

function pickProductCover(
  images: { url: string; isPrimary: boolean; sortOrder: number }[],
): string | null {
  if (images.length === 0) return null;
  const primary = images.find((image) => image.isPrimary);
  if (primary) return primary.url;
  return [...images].sort((a, b) => a.sortOrder - b.sortOrder)[0]?.url ?? null;
}

export function toPublicApplicationListItem(row: Application): PublicApplicationListItem {
  return {
    name: row.name,
    slug: row.slug,
    summary: row.summary,
    coverImageUrl: row.coverImageUrl,
    featured: row.featured,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

export function toPublicApplicationDetail(row: ApplicationPublicRow): PublicApplicationDetail {
  return {
    name: row.name,
    slug: row.slug,
    summary: row.summary,
    coverImageUrl: row.coverImageUrl,
    featured: row.featured,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    description: row.description,
    // 只返回「已发布」的产品（产品自身状态独立于应用场景）
    products: row.products
      .filter((link) => link.product.status === 'PUBLISHED')
      .sort((a, b) => a.sortOrder - b.sortOrder || a.productId.localeCompare(b.productId))
      .map((link) => ({
        name: link.product.name,
        slug: link.product.slug,
        shortDescription: link.product.shortDescription,
        coverImageUrl: pickProductCover(link.product.images),
      })),
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}
