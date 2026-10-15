import { BadRequestException } from '@nestjs/common';

/**
 * 媒体文件校验与元数据解析（Phase 4.3）。
 *
 * 安全层次：MIME 白名单 → 大小限制 → **内容魔数校验**（扩展名/MIME 可伪造，
 * 内容特征不可轻易伪造）→ UUID 文件名（LocalProvider 负责）。
 * 本模块只读 buffer，不触碰文件系统。
 */

/** 上传大小上限：10MB（环境变量 MEDIA_MAX_FILE_SIZE 可覆盖，单位字节） */
export const MAX_MEDIA_FILE_SIZE = (() => {
  const raw = process.env.MEDIA_MAX_FILE_SIZE;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024;
})();

/** 图片 MIME → 扩展名白名单（Phase 4.3；不对外开放 PDF） */
export const ALLOWED_IMAGE_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

/**
 * 文档 MIME → 扩展名白名单（Phase 4.5 起开放）。
 *
 * 用途：Quality CMS 的认证证书 / 检测报告需要 PDF 载体。
 * 安全约束不变——仍走 MIME 白名单 + 大小限制 + **魔数校验**（`%PDF-`）。
 */
export const ALLOWED_DOCUMENT_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
};

/** 上传总白名单（图片 + 文档） */
export const ALLOWED_MEDIA_MIME: Record<string, string> = {
  ...ALLOWED_IMAGE_MIME,
  ...ALLOWED_DOCUMENT_MIME,
};

export function isAllowedMediaMime(mimeType: string): boolean {
  return Object.hasOwn(ALLOWED_MEDIA_MIME, mimeType);
}

/** 该 MIME 是否为文档类（决定落库的 MediaCategory） */
export function isDocumentMime(mimeType: string): boolean {
  return Object.hasOwn(ALLOWED_DOCUMENT_MIME, mimeType);
}

/** 上传前置校验：MIME + 大小（魔数校验在 buffer 就绪后执行） */
export function validateUpload(file: { mimetype?: string; size?: number }): void {
  const mime = file.mimetype ?? '';
  if (!isAllowedMediaMime(mime)) {
    throw new BadRequestException(
      `不支持的文件格式: ${mime || 'unknown'}（仅支持 JPEG / PNG / WebP / AVIF / PDF）`,
    );
  }
  if (typeof file.size === 'number' && file.size > MAX_MEDIA_FILE_SIZE) {
    throw new BadRequestException(`文件超过大小限制（最大 ${Math.floor(MAX_MEDIA_FILE_SIZE / (1024 * 1024))}MB）`);
  }
  if (file.size === 0) {
    throw new BadRequestException('文件内容为空');
  }
}

/** 魔数（magic bytes）校验：确认 buffer 真的是声明格式的文件 */
export function verifyImageSignature(buffer: Buffer, mimeType: string): boolean {
  // PDF 头较短（"%PDF-" 仅 5 字节），单独处理，不受图片 12 字节下限约束
  if (mimeType === 'application/pdf') {
    return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  }

  if (buffer.length < 12) return false;

  const ascii = (from: number, to: number): string => buffer.subarray(from, to).toString('latin1');

  switch (mimeType) {
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png':
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/avif':
      return ascii(4, 8) === 'ftyp' && (ascii(8, 12) === 'avif' || ascii(8, 12) === 'avis');
    default:
      return false;
  }
}

/**
 * 解析图片像素尺寸（尽力而为）：从文件头读取，失败返回 null。
 * 支持 PNG（IHDR）、JPEG（SOF 扫描）、WebP（VP8 / VP8L / VP8X）、AVIF（ispe）。
 */
export function parseImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  try {
    switch (mimeType) {
      case 'image/png':
        return parsePng(buffer);
      case 'image/jpeg':
        return parseJpeg(buffer);
      case 'image/webp':
        return parseWebp(buffer);
      case 'image/avif':
        return parseAvif(buffer);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/* ------------------------------ 各格式解析 ------------------------------ */

function parsePng(buffer: Buffer): { width: number; height: number } | null {
  // PNG: 8 字节签名 + 4 字节长度 + "IHDR" + width(4 BE) + height(4 BE)
  if (buffer.length < 24) return null;
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseJpeg(buffer: Buffer): { width: number; height: number } | null {
  // JPEG: 逐段扫描，找 SOF0–SOF15（0xC0–0xCF，排除 C4/C8/CC）
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return null; // 进入扫描数据，尺寸段已过
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function parseWebp(buffer: Buffer): { width: number; height: number } | null {
  const chunk = buffer.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    // 扩展格式：canvas 尺寸为 24 位小端（+1）
    if (buffer.length < 30) return null;
    return {
      width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    // 有损：尺寸在 chunk 数据起始后（14 位掩码，小端）
    if (buffer.length < 30) return null;
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    // 无损：1 位签名 + 14 位宽 + 14 位高（小端拼装）
    if (buffer.length < 25) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function parseAvif(buffer: Buffer): { width: number; height: number } | null {
  // AVIF/HEIF: 从 0 开始遍历顶层 box，找 'ispe'（image spatial extents）
  let offset = 0;
  while (offset + 20 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'ispe') {
      return {
        width: buffer.readUInt32BE(offset + 12),
        height: buffer.readUInt32BE(offset + 16),
      };
    }
    if (size <= 0) break;
    offset += size;
  }
  return null;
}
