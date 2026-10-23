import { Logger } from '@nestjs/common';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { isDocumentMime } from './media-file.util';

/**
 * 上传图片压缩（Phase 6.0）。
 *
 * 位置：MediaService / 产品图片上传在**校验通过之后、写入存储之前**统一调用，
 * 因此无论是媒体库上传、产品图片上传还是未来新增的入口，都会经过同一套压缩逻辑
 * （客户端绕过不了）。
 *
 * 策略：
 *   · PDF 等文档原样通过，不做任何重编码
 *   · EXIF 方向自动摆正（手机竖拍照片不再横躺），随后**剥离全部元数据**
 *     （含 GPS 等隐私信息）
 *   · 长边超过 2000px 等比缩小，**不放大**小图（避免糊化）
 *   · 保持原格式重新编码（jpeg/png/webp/avif）——不擅自改扩展名，
 *     避免破坏 OG 图片等对格式有要求的场景
 *   · 压缩后反而更大时（小图常见）保留原图，绝不做「负优化」
 *   · 任何编码异常都降级为「使用原图」，不阻断上传（魔数已校验过，内容可信）
 */

/** 长边上限（像素）。商品图/文章图在 2000px 内已足够 2x 屏清晰度 */
const MAX_EDGE = 2000;

const LOGGER = new Logger('ImageOptimize');

export interface OptimizedImage {
  buffer: Buffer;
  mimeType: string;
  width: number | null;
  height: number | null;
  /** 原始字节数 */
  originalSize: number;
  /** 最终字节数 */
  size: number;
  /** 是否真的发生了压缩（false = 原图直传） */
  optimized: boolean;
}

/** 各格式的编码参数：质量与体积的平衡点 */
function encodeWith(image: Sharp, mimeType: string): Sharp {
  switch (mimeType) {
    case 'image/jpeg':
      return image.jpeg({ quality: 82, mozjpeg: true, progressive: true });
    case 'image/png':
      // palette 量化对 UI 截图/线稿收益最大；照片类 PNG 仍会保留足够色阶
      return image.png({ compressionLevel: 9, palette: true, quality: 90 });
    case 'image/webp':
      return image.webp({ quality: 82, effort: 4 });
    case 'image/avif':
      return image.avif({ quality: 55, effort: 4 });
    default:
      return image;
  }
}

export async function optimizeImage(buffer: Buffer, mimeType: string): Promise<OptimizedImage> {
  const passthrough: OptimizedImage = {
    buffer,
    mimeType,
    width: null,
    height: null,
    originalSize: buffer.length,
    size: buffer.length,
    optimized: false,
  };

  // 文档（PDF）不参与图片压缩
  if (isDocumentMime(mimeType)) return passthrough;

  try {
    const pipeline = sharp(buffer, { failOn: 'none' }).rotate();
    const meta = await pipeline.metadata();

    // 原图（摆正后）尺寸：EXIF Orientation 5-8 时宽高互换
    const swapped = (meta.orientation ?? 1) >= 5;
    const rawWidth = meta.width ?? null;
    const rawHeight = meta.height ?? null;
    const originalWidth = swapped ? rawHeight : rawWidth;
    const originalHeight = swapped ? rawWidth : rawHeight;

    const resized = pipeline.resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    });

    // resolveWithObject 返回**编码后**的真实尺寸——
    // 缩放过的图必须记录新尺寸，否则前台按原尺寸预留空间会出现布局跳动
    const { data, info } = await encodeWith(resized, mimeType).toBuffer({ resolveWithObject: true });

    // 压缩没有收益时保留原图（小图/已优化图常见），尺寸用原图尺寸
    if (data.length >= buffer.length) {
      return { ...passthrough, width: originalWidth, height: originalHeight };
    }

    return {
      buffer: data,
      mimeType,
      width: info.width ?? originalWidth,
      height: info.height ?? originalHeight,
      originalSize: buffer.length,
      size: data.length,
      optimized: true,
    };
  } catch (error) {
    // 编码失败不阻断上传：魔数已校验，内容仍是合法图片，原样存储即可
    LOGGER.warn(`图片压缩跳过（${mimeType}）：${(error as Error).message}`);
    return passthrough;
  }
}
