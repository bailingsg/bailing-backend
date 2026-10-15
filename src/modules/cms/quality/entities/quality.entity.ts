import type { MediaAsset, QualityRecord } from '@prisma/client';

/**
 * Quality CMS 对外实体（响应结构）。
 *
 * 安全约定：media 引用一律**不返回 storageKey、createdBy、provider** 等内部字段，
 * 只暴露公开渲染所需的地址与展示元数据。
 *
 * 数据诚实原则：证书编号 / 颁发机构 / 日期均可为空，后台以 null 原样返回，
 * **绝不用占位文本或推断值填充**（缺失就是缺失）。
 */

/** 证书 / 报告所引用的媒体（精简视图，不含内部键） */
export interface QualityMediaRefDto {
  id: string;
  url: string;
  /** 原始文件名（用于区分 PDF 证书与图片） */
  originalName: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
  /** 是否文档（PDF）：前端据此选择预览方式 */
  isDocument: boolean;
}

/** 质量记录列表项 */
export interface QualityRecordListItemDto {
  id: string;
  title: string;
  slug: string;
  recordType: string;
  issuer: string | null;
  certificateNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  status: string;
  sortOrder: number;
  mediaId: string | null;
  media: QualityMediaRefDto | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 质量记录详情（含描述与 SEO） */
export interface QualityRecordDetailDto extends QualityRecordListItemDto {
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface PaginatedQualityRecordsDto {
  items: QualityRecordListItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/* ------------------------------ 关联类型 ------------------------------ */

export type QualityRecordWithRelations = QualityRecord & {
  media: MediaAsset | null;
};

/* ------------------------------ 映射器 ------------------------------ */

/** 判断媒体是否按文档（PDF）处理 */
function isDocumentMime(mimeType: string | null | undefined): boolean {
  return mimeType === 'application/pdf';
}

export function toQualityMediaRef(media: MediaAsset | null): QualityMediaRefDto | null {
  if (!media) return null;
  return {
    id: media.id,
    url: media.url,
    originalName: media.originalName,
    altText: media.altText,
    width: media.width,
    height: media.height,
    mimeType: media.mimeType,
    isDocument: isDocumentMime(media.mimeType),
  };
}

export function toQualityRecordListItem(row: QualityRecordWithRelations): QualityRecordListItemDto {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    recordType: row.recordType,
    issuer: row.issuer,
    certificateNumber: row.certificateNumber,
    issueDate: row.issueDate ? row.issueDate.toISOString() : null,
    expiryDate: row.expiryDate ? row.expiryDate.toISOString() : null,
    status: row.status,
    sortOrder: row.sortOrder,
    mediaId: row.mediaId,
    media: toQualityMediaRef(row.media),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toQualityRecordDetail(row: QualityRecordWithRelations): QualityRecordDetailDto {
  return {
    ...toQualityRecordListItem(row),
    description: row.description,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}
