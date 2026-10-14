import { MediaCategory, MediaProvider } from '@prisma/client';
import type { MediaAsset } from '@prisma/client';

/**
 * CMS Media 对外实体（响应结构）。
 *
 * 注意：**不包含任何服务器真实文件路径**——storageKey 是存储对象键
 * （media/<YYYY>/<MM>/<uuid>.<ext>），不是文件系统路径；绝对路径只存在于
 * StorageProvider 内部。
 */

export interface MediaAssetDto {
  id: string;
  filename: string;
  originalName: string;
  storageKey: string;
  url: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  provider: MediaProvider;
  category: MediaCategory;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedMediaDto {
  items: MediaAssetDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function toMediaAssetDto(asset: MediaAsset): MediaAssetDto {
  return {
    id: asset.id,
    filename: asset.filename,
    originalName: asset.originalName,
    storageKey: asset.storageKey,
    url: asset.url,
    mimeType: asset.mimeType,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    altText: asset.altText,
    provider: asset.provider,
    category: asset.category,
    createdBy: asset.createdBy,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}
