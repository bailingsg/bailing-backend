import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MediaProvider } from '@prisma/client';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoredObject, StorageProvider, UploadObject } from './storage.interface';
import { ALLOWED_MEDIA_MIME } from '../media-file.util';

/**
 * MIME → 扩展名白名单。
 *
 * 直接复用 media-file.util 的单一来源（图片 + 文档），
 * 避免「上传校验放行、落盘阶段拒绝」的两处白名单漂移。
 */
const MIME_TO_EXT: Record<string, string> = ALLOWED_MEDIA_MIME;

/**
 * storageKey 白名单：media/<4位年>/<2位月>/<uuid>.<ext>
 * 任何输入（含来自数据库的 url 反推）都必须匹配才允许拼路径——防路径穿越总闸。
 */
const STORAGE_KEY_PATTERN = /^media\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;

/**
 * storageKey 的「命名空间前缀」。
 * 注意：media/ 是**逻辑命名空间**（保证 url 形如 /uploads/media/<年>/<月>/...），
 * 物理路径以 rootDir（即媒体根目录，默认 <cwd>/uploads/media）为基准，
 * 拼接时剥离开名前缀——否则会出现 uploads/media/media/ 双前缀导致静态路由 404。
 */
const KEY_NAMESPACE = 'media/';

export interface LocalStorageOptions {
  /** 存储根目录（默认 <cwd>/uploads/media） */
  rootDir: string;
  /** 访问基地址（如 http://127.0.0.1:4000，生产可指向 CDN 域名） */
  uploadsBaseUrl: string;
}

/**
 * 本地磁盘存储提供方。
 *
 * 安全约束：
 *   · storageKey 一律由服务端生成（UUID + 白名单扩展名）
 *   · 所有外部输入的 key 先过 STORAGE_KEY_PATTERN 白名单，再过 resolved-path
 *     包含校验（双保险，防 ../ 穿越）
 *   · 删除按 key 定位文件，不存在则静默成功
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  readonly provider = MediaProvider.LOCAL;
  private readonly logger = new Logger(LocalStorageProvider.name);

  constructor(private readonly options: LocalStorageOptions) {}

  async upload(object: UploadObject): Promise<StoredObject> {
    const ext = MIME_TO_EXT[object.mimeType];
    if (!ext) {
      throw new BadRequestException(`不支持的文件格式: ${object.mimeType || 'unknown'}`);
    }

    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const filename = `${randomUUID()}${ext}`;
    const storageKey = `media/${year}/${month}/${filename}`;

    const filePath = this.resolvePath(storageKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, object.buffer);

    return { storageKey, filename, url: this.getUrl(storageKey) };
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await unlink(this.resolvePath(storageKey));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // 删除失败不阻断数据库记录清理（孤儿文件可由运维回收），仅记录
        this.logger.warn(`删除媒体文件失败（${storageKey}）: ${(error as Error).message}`);
      }
    }
  }

  getUrl(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new BadRequestException('非法的存储对象键');
    }
    const base = this.options.uploadsBaseUrl.replace(/\/$/, '');
    return `${base}/uploads/${storageKey}`;
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await readFile(this.resolvePath(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  /** storageKey → 绝对路径（白名单正则 + 目录包含双重校验） */
  private resolvePath(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new BadRequestException('非法的存储对象键');
    }
    // 剥离逻辑命名空间前缀，物理路径相对媒体根目录（避免 media/media/ 双前缀）
    const relative = storageKey.startsWith(KEY_NAMESPACE)
      ? storageKey.slice(KEY_NAMESPACE.length)
      : storageKey;
    const resolved = path.resolve(this.options.rootDir, relative);
    const root = path.resolve(this.options.rootDir);
    if (!resolved.startsWith(root + path.sep)) {
      throw new BadRequestException('非法的存储对象键');
    }
    return resolved;
  }
}
