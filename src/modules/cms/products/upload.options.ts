import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { diskStorage, memoryStorage } from 'multer';
import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Request } from 'express';
import path from 'node:path';

/**
 * 产品图片本地存储（Phase 4.2）。
 *
 * 安全约束：
 *   · 只允许 jpeg / png / webp / avif 四种图片 MIME（扩展名白名单同步校验）
 *   · 大小限制默认 5MB（环境变量 UPLOAD_MAX_FILE_SIZE 可覆盖，单位字节）
 *   · 落盘文件名一律由服务端生成（UUID + 扩展名），**永不使用客户端原始文件名**
 *     ——原始文件名可能含路径穿越字符（../）或特殊字符
 *   · 上传后由 Service 再做「魔数（magic bytes）」校验，防止伪造 MIME 的
 *     非图片内容（如把 .php/.html 改名为 .jpg）
 */

/** 本地存储目录：<cwd>/uploads/products（.gitignore 已排除） */
export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
export const PRODUCT_UPLOAD_DIR = path.join(UPLOAD_ROOT, 'products');

/** URL 前缀（与 app.setup.ts 的静态资源挂载一致） */
export const UPLOAD_URL_PREFIX = '/uploads/products';

const MAX_FILE_SIZE = (() => {
  const raw = process.env.UPLOAD_MAX_FILE_SIZE;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 1024 * 1024;
})();

/** MIME → 扩展名白名单（两者必须一致） */
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

const ALLOWED_EXTENSIONS = new Set(Object.values(ALLOWED_IMAGE_TYPES));

/**
 * multer fileFilter 回调类型。
 * 与 @nestjs/platform-express 期望的 MulterOptions.fileFilter 回调签名保持一致
 * （双参数：error 优先，error 为 null 时 acceptFile 决定是否接受）。
 */
type ImageFileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

/** 服务端生成的安全文件名：UUID + 白名单扩展名 */
export function generateStoredFileName(mimeType: string): string {
  const ext = ALLOWED_IMAGE_TYPES[mimeType];
  if (!ext) throw new BadRequestException('不支持的图片格式');
  return `${randomUUID()}${ext}`;
}

/** 从存储 URL 取文件名并做安全校验（防路径穿越） */
export function safeFileNameFromUrl(url: string): string | null {
  const base = url.split('/').pop() ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/i.test(base)) {
    return null;
  }
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;
  return base;
}

/** 魔数（magic bytes）校验：确认真的是图片而不是改了扩展名的其他内容 */
export async function verifyImageSignature(
  filePath: string,
  mimeType: string,
): Promise<boolean> {
  const { readFile } = await import('node:fs/promises');
  let head: Buffer;
  try {
    head = await readFile(filePath);
  } catch {
    return false;
  }
  head = head.subarray(0, 16);

  const startsWith = (bytes: number[], offset = 0): boolean =>
    bytes.every((b, i) => head[offset + i] === b);

  const ascii = (from: number, to: number): string =>
    head.subarray(from, to).toString('latin1');

  switch (mimeType) {
    case 'image/jpeg':
      return startsWith([0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/avif':
      return ascii(4, 8) === 'ftyp' && (ascii(8, 12) === 'avif' || ascii(8, 12) === 'avis');
    default:
      return false;
  }
}

/** 确保上传目录存在（启动与测试均安全） */
export function ensureUploadDirs(): void {
  mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
}

/**
 * 共用的图片 fileFilter：MIME 与扩展名必须同属白名单。
 * 磁盘存储与内存存储两套配置共用，避免两处校验漂移。
 */
function imageFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: ImageFileFilterCallback,
): void {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExt = ALLOWED_IMAGE_TYPES[file.mimetype];
  if (!allowedExt) {
    cb(new BadRequestException(`不支持的图片格式: ${file.mimetype || 'unknown'}`), false);
    return;
  }
  // MIME 与扩展名必须同属白名单（扩展名不作为唯一依据）
  if (ext !== allowedExt && !(allowedExt === '.jpg' && (ext === '.jpg' || ext === '.jpeg'))) {
    cb(new BadRequestException('图片扩展名与内容类型不匹配'), false);
    return;
  }
  cb(null, true);
}

/**
 * Phase 6.0：产品图片改为**内存接收**，再由 StorageProvider 统一写入
 * （COS 或本地磁盘）。控制器与服务层都不再直接接触文件系统路径，
 * 与媒体库上传保持同一条链路。
 */
export function productImageUploadOptions(): MulterOptions {
  return {
    storage: memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    fileFilter: imageFileFilter,
  };
}

/**
 * 历史遗留的磁盘存储配置（Phase 4.2 形态）。
 * 仅用于兼容：旧产品图仍以 /uploads/products/<file> 形式存在，
 * 删除这些文件时需要知道落盘目录。新上传不再使用本配置。
 */
export function legacyProductImageDiskOptions(): MulterOptions {
  ensureUploadDirs();

  return {
    storage: diskStorage({
      destination: (_req: Request, _file: Express.Multer.File, cb) => cb(null, PRODUCT_UPLOAD_DIR),
      filename: (_req: Request, file: Express.Multer.File, cb) => {
        try {
          cb(null, generateStoredFileName(file.mimetype));
        } catch (error) {
          cb(error as Error, '');
        }
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    fileFilter: imageFileFilter,
  };
}
