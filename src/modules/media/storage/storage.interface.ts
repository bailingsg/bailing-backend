import type { MediaProvider } from '@prisma/client';

/**
 * Storage Provider 统一接口（Phase 4.3 Storage Adapter 模式）。
 *
 * 架构原则：业务模块（Product 等）→ MediaService → StorageProvider → Local / COS / CDN。
 * 未来接入腾讯云 COS 时新增 TencentCosStorageProvider 实现并通过环境变量切换，
 * **业务代码零修改**。
 */
export interface StorageProvider {
  /** 提供方标识（与 MediaAsset.provider 对应，落库用） */
  readonly provider: MediaProvider;

  /**
   * 上传对象。
   * @param object.buffer 文件内容（控制器以内存存储接收，避免业务层碰文件系统）
   * @returns 存储对象信息（storageKey / filename / url）
   */
  upload(object: UploadObject): Promise<StoredObject>;

  /** 删除对象（不存在时静默成功——调用方已做存在性校验） */
  delete(storageKey: string): Promise<void>;

  /** 由对象键生成访问地址（本地为 /uploads 前缀，未来为 CDN 域名） */
  getUrl(storageKey: string): string;

  /** 对象是否存在 */
  exists(storageKey: string): Promise<boolean>;
}

export interface UploadObject {
  buffer: Buffer;
  /** 客户端原始文件名（仅登记展示，禁止参与路径拼接） */
  originalName: string;
  mimeType: string;
}

export interface StoredObject {
  /** 存储对象键：media/<YYYY>/<MM>/<uuid>.<ext> */
  storageKey: string;
  /** 存储文件名（UUID + 白名单扩展名） */
  filename: string;
  /** 访问地址（由 provider 生成） */
  url: string;
}

/** Injection token：业务代码只依赖接口，不依赖具体实现 */
export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';
