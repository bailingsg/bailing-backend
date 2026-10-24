import { MediaCategory, MediaProvider, MediaUsage } from '@prisma/client';
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
  /** Phase 5.0：图片 SEO 元数据 */
  title: string | null;
  caption: string | null;
  description: string | null;
  provider: MediaProvider;
  category: MediaCategory;
  /** Phase 5.6：业务用途分类（null = 未分类） */
  usage: MediaUsage | null;
  /**
   * 引用计数：被业务记录引用的次数（产品图 / 博客封面 / 工厂分区与图库 /
   * 质量证书 / 应用封面 / 站点分区配图）。0 = 未被引用，可安全删除。
   *
   * 与删除前引用检查（remove → countReferences）同一套匹配规则：
   * 外键 *MediaId 直接命中，url 精确 + 文件名后缀双匹配（兼容基地址变化）。
   */
  referenceCount: number;
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

/**
 * MediaAsset → MediaAssetDto。
 *
 * referenceCount 由调用方按场景填充：
 *   · 列表 / 详情 / 更新后 —— 传真实引用计数（删除保护同源规则）
 *   · 上传成功 —— 新资产不可能被引用，缺省 0
 */
export function toMediaAssetDto(asset: MediaAsset, referenceCount = 0): MediaAssetDto {
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
    title: asset.title,
    caption: asset.caption,
    description: asset.description,
    provider: asset.provider,
    category: asset.category,
    usage: asset.usage,
    referenceCount,
    createdBy: asset.createdBy,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}
