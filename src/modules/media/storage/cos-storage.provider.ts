import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MediaProvider } from '@prisma/client';
import COS from 'cos-nodejs-sdk-v5';
import { randomUUID } from 'node:crypto';
import type { StoredObject, StorageProvider, UploadObject } from './storage.interface';
import { ALLOWED_MEDIA_MIME } from '../media-file.util';

/**
 * 腾讯云 COS 存储提供方（Phase 6.0）。
 *
 * 与 LocalStorageProvider 保持同一契约：业务代码只依赖 StorageProvider 接口，
 * 通过 STORAGE_PROVIDER=TENCENT_COS 切换，业务模块零改动。
 *
 * 关键设计：
 *   · 存储桶为**私有读写**，对象不对外公开；公网读取一律经 CDN 回源
 *     （CDN 侧「私有存储桶访问」已授权，仅 GET/HEAD/OPTIONS 权限）。
 *   · 落库 URL 由 COS_CDN_DOMAIN + storageKey 拼成，**不带 bucket 域名**——
 *     将来更换 CDN 域名只需改一个环境变量，不必批量改库。
 *   · 密钥只来自环境变量，且为 CAM 子用户（仅该桶对象级读写），
 *     代码不提供任何默认值，缺失即启动失败。
 *   · storageKey 一律服务端生成（UUID + 白名单扩展名），外部传入的 key
 *     先过白名单正则，避免越权操作桶内其它对象。
 */

/** storageKey 白名单：media/<4位年>/<2位月>/<uuid>.<ext>（与本地 Provider 一致） */
const STORAGE_KEY_PATTERN =
  /^media\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;

/**
 * 对象缓存头（Phase 6.1）。
 *
 * 文件名是 UUID、内容永不复用，本来可以长期缓存；但「删除图片」后如果浏览器
 * 一年不回头（immutable + max-age=31536000），删掉的图在用户设备上会长期残留。
 * 取舍：改成 7 天且**去掉 immutable**——7 天后浏览器带 ETag 复查，内容没变
 * 就是 304，流量代价极小，换来「误删可在一周内自然收敛」。
 *
 * 注意：这只是浏览器侧。CDN 边缘另有缓存规则（控制台配置），两边需一起看，
 * 单改任何一侧都无法让已删除的对象立刻消失。
 */
const OBJECT_CACHE_CONTROL = 'public, max-age=604800';

export interface CosStorageOptions {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  /** 对外访问域名，如 https://cdn.bailingwooden.com（不带末尾斜杠） */
  cdnDomain: string;
}

@Injectable()
export class TencentCosStorageProvider implements StorageProvider {
  readonly provider = MediaProvider.TENCENT_COS;

  private readonly logger = new Logger(TencentCosStorageProvider.name);
  private readonly cos: COS;
  private readonly cdnDomain: string;

  constructor(private readonly options: CosStorageOptions) {
    this.cos = new COS({
      SecretId: options.secretId,
      SecretKey: options.secretKey,
    });
    this.cdnDomain = options.cdnDomain.replace(/\/+$/, '');
  }

  async upload(object: UploadObject): Promise<StoredObject> {
    const ext = ALLOWED_MEDIA_MIME[object.mimeType];
    if (!ext) {
      throw new BadRequestException(`不支持的文件格式: ${object.mimeType || 'unknown'}`);
    }

    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const filename = `${randomUUID()}${ext}`;
    const storageKey = `media/${year}/${month}/${filename}`;

    try {
      await this.putObject({
        Key: storageKey,
        Body: object.buffer,
        ContentType: object.mimeType,
        CacheControl: OBJECT_CACHE_CONTROL,
      });
    } catch (error) {
      // 不回显密钥；仅记录可定位的桶/地域/对象键
      this.logger.error(
        `COS 上传失败（bucket=${this.options.bucket} region=${this.options.region} key=${storageKey}）: ${describeCosError(error)}`,
      );
      throw error;
    }

    return { storageKey, filename, url: this.getUrl(storageKey) };
  }

  async delete(storageKey: string): Promise<void> {
    this.assertKey(storageKey);
    try {
      await this.deleteObject(storageKey);
    } catch (error) {
      // 与本地 Provider 语义一致：删除失败不阻断数据库记录清理，仅记录待运维回收
      this.logger.warn(`删除 COS 对象失败（${storageKey}）: ${describeCosError(error)}`);
    }
  }

  getUrl(storageKey: string): string {
    this.assertKey(storageKey);
    return `${this.cdnDomain}/${storageKey}`;
  }

  keyFromUrl(url: string): string | null {
    const prefix = `${this.cdnDomain}/`;
    if (!url.startsWith(prefix)) return null;
    const key = url.slice(prefix.length);
    return STORAGE_KEY_PATTERN.test(key) ? key : null;
  }

  async exists(storageKey: string): Promise<boolean> {
    this.assertKey(storageKey);
    try {
      await this.headObject(storageKey);
      return true;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  /* --------------------------- SDK Promise 封装 --------------------------- */

  private putObject(params: {
    Key: string;
    Body: Buffer;
    ContentType: string;
    CacheControl: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cos.putObject(
        {
          Bucket: this.options.bucket,
          Region: this.options.region,
          Key: params.Key,
          Body: params.Body,
          ContentType: params.ContentType,
          CacheControl: params.CacheControl,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  private deleteObject(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cos.deleteObject(
        { Bucket: this.options.bucket, Region: this.options.region, Key: key },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  private headObject(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cos.headObject(
        { Bucket: this.options.bucket, Region: this.options.region, Key: key },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  /** 外部传入的 key 必须命中白名单，防止越权访问/删除桶内其它对象 */
  private assertKey(storageKey: string): void {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new BadRequestException('非法的存储对象键');
    }
  }
}

/** 把 SDK 错误压成一行可读信息（不含任何凭据） */
function describeCosError(error: unknown): string {
  const e = error as { statusCode?: number; code?: string; message?: string };
  return [e?.statusCode, e?.code, e?.message].filter(Boolean).join(' ') || 'unknown error';
}
