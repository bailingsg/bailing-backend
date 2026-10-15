import type { FactoryExhibition, FactoryImage, FactorySection, MediaAsset } from '@prisma/client';

/**
 * Factory CMS 对外实体（响应结构）。
 *
 * 安全约定：coverMedia / images.media 一律**不返回 storageKey、createdBy、provider**
 * 等内部字段——只暴露公开渲染所需的地址与展示元数据。
 */

/** 封面 / 图片所引用的媒体（精简视图，不含内部键） */
export interface FactoryMediaRefDto {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
}

/** 分区图库中的一张图 */
export interface FactoryImageDto {
  id: string;
  mediaId: string;
  altText: string | null;
  sortOrder: number;
  /** 归属展会（为空表示属于分区图库） */
  exhibitionId: string | null;
  media: FactoryMediaRefDto | null;
}

/** 参展记录 */
export interface FactoryExhibitionDto {
  id: string;
  sectionId: string;
  name: string;
  heldOn: string | null;
  location: string | null;
  description: string | null;
  sortOrder: number;
  isVisible: boolean;
  photoCount: number;
  photos: FactoryImageDto[];
  createdAt: string;
  updatedAt: string;
}

/** 工厂分区列表项 */
export interface FactorySectionListItemDto {
  id: string;
  title: string;
  slug: string;
  sectionType: string;
  summary: string | null;
  status: string;
  sortOrder: number;
  coverImageUrl: string | null;
  coverMediaId: string | null;
  coverMedia: FactoryMediaRefDto | null;
  imageCount: number;
  exhibitionCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 工厂分区详情（含正文、图库、展会、SEO） */
export interface FactorySectionDetailDto extends FactorySectionListItemDto {
  content: string | null;
  images: FactoryImageDto[];
  exhibitions: FactoryExhibitionDto[];
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface PaginatedFactorySectionsDto {
  items: FactorySectionListItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/* ------------------------------ 关联类型 ------------------------------ */

export type FactorySectionWithRelations = FactorySection & {
  coverMedia: MediaAsset | null;
  images: (FactoryImage & { media: MediaAsset | null })[];
  exhibitions: (FactoryExhibition & { photos: (FactoryImage & { media: MediaAsset | null })[] })[];
  _count?: { images: number; exhibitions: number };
};

/* ------------------------------ 映射器 ------------------------------ */

function toMediaRef(media: MediaAsset | null): FactoryMediaRefDto | null {
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

export function toFactoryImageDto(row: FactoryImage & { media: MediaAsset | null }): FactoryImageDto {
  return {
    id: row.id,
    mediaId: row.mediaId,
    altText: row.altText,
    sortOrder: row.sortOrder,
    exhibitionId: row.exhibitionId,
    media: toMediaRef(row.media),
  };
}

export function toFactoryExhibitionDto(
  row: FactoryExhibition & { photos: (FactoryImage & { media: MediaAsset | null })[] },
): FactoryExhibitionDto {
  const photos = row.photos
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map(toFactoryImageDto);
  return {
    id: row.id,
    sectionId: row.sectionId,
    name: row.name,
    heldOn: row.heldOn ? row.heldOn.toISOString() : null,
    location: row.location,
    description: row.description,
    sortOrder: row.sortOrder,
    isVisible: row.isVisible,
    photoCount: photos.length,
    photos,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toFactorySectionListItem(row: FactorySectionWithRelations): FactorySectionListItemDto {
  // 分区图库只统计「未归属展会」的图，避免与展会照片重复计数
  const galleryImages = row.images.filter((image) => image.exhibitionId === null);
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    sectionType: row.sectionType,
    summary: row.summary,
    status: row.status,
    sortOrder: row.sortOrder,
    coverImageUrl: row.coverImageUrl,
    coverMediaId: row.coverMediaId,
    coverMedia: toMediaRef(row.coverMedia),
    imageCount: galleryImages.length,
    exhibitionCount: row.exhibitions.length,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toFactorySectionDetail(row: FactorySectionWithRelations): FactorySectionDetailDto {
  const base = toFactorySectionListItem(row);
  const galleryImages = row.images
    .filter((image) => image.exhibitionId === null)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map(toFactoryImageDto);

  return {
    ...base,
    content: row.content,
    images: galleryImages,
    exhibitions: row.exhibitions
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map(toFactoryExhibitionDto),
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}
