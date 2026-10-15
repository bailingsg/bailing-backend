import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MediaCategory, Prisma } from '@prisma/client';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { ListMediaQueryDto } from './dto/list-media-query.dto';
import {
  parseImageDimensions,
  validateUpload,
  verifyImageSignature,
} from './media-file.util';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage/storage.interface';
import {
  toMediaAssetDto,
  type MediaAssetDto,
  type PaginatedMediaDto,
} from './entities/media.entity';

/**
 * 媒体资源服务（Phase 4.3 Media Library）。
 *
 * 架构位置：业务模块 → MediaService → StorageProvider → Local / COS / CDN。
 * 本服务是唯一允许触碰「上传」语义的模块；Product 等业务模块不得直接操作文件系统。
 */

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const ORIGINAL_NAME_MAX = 200;

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /* ------------------------------ 上传 ------------------------------ */

  /**
   * 上传媒体（控制器以内存存储接收文件，本服务完成校验并委托 StorageProvider 落盘）。
   * 流程：MIME/大小校验 → 魔数校验 → 尺寸解析 → Provider 上传 → 落库。
   */
  async upload(file: Express.Multer.File, userId: string): Promise<MediaAssetDto> {
    validateUpload(file);

    if (!verifyImageSignature(file.buffer, file.mimetype)) {
      throw new BadRequestException('文件内容不是受支持的图片格式（jpeg / png / webp / avif）');
    }

    const dimensions = parseImageDimensions(file.buffer, file.mimetype);

    const stored = await this.storage.upload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });

    const asset = await this.prisma.mediaAsset.create({
      data: {
        filename: stored.filename,
        originalName: sanitizeOriginalName(file.originalname),
        storageKey: stored.storageKey,
        url: stored.url,
        mimeType: file.mimetype,
        size: file.size,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        category: MediaCategory.IMAGE,
        provider: this.storage.provider,
        createdBy: userId,
      },
    });

    return toMediaAssetDto(asset);
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 媒体列表：分页 + keyword（originalName/filename）+ category 筛选 */
  async list(query: ListMediaQueryDto): Promise<PaginatedMediaDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.MediaAssetWhereInput = {};
    if (query.category) where.category = query.category;
    if (query.keyword) {
      where.OR = [
        { originalName: { contains: query.keyword, mode: 'insensitive' } },
        { filename: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.mediaAsset.count({ where }),
      this.prisma.mediaAsset.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map(toMediaAssetDto),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 媒体详情 */
  async findById(id: string): Promise<MediaAssetDto> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('媒体资源不存在');
    return toMediaAssetDto(asset);
  }

  /* ------------------------------ 删除 ------------------------------ */

  /**
   * 删除媒体：先做引用检查（被 ProductImage / BlogPost 封面等业务记录引用 → 400），
   * 再删数据库记录，最后委托 StorageProvider 删除文件。
   */
  async remove(id: string): Promise<{ id: string }> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('媒体资源不存在');

    const referenced = await this.countReferences(asset);
    if (referenced > 0) {
      throw new BadRequestException('Media asset is in use.');
    }

    await this.prisma.mediaAsset.delete({ where: { id } });
    await this.storage.delete(asset.storageKey);
    return { id };
  }

  /**
   * 引用计数：业务表中引用该资产的记录数。
   *
   * 覆盖范围（Phase 4.3 起 ProductImage，Phase 4.4 起 BlogPost 封面）：
   *   · ProductImage.url —— 产品图片
   *   · BlogPost.coverMediaId —— 博客封面（外键引用，最可靠）
   *   · BlogPost.coverImageUrl —— 博客封面地址快照（兼容外链与历史数据）
   *
   * 匹配策略（url 精确匹配 + 文件名后缀匹配双保险）：
   *   · url 精确相等——同一 Provider 生成的地址一致
   *   · url 以 /<filename> 结尾——兼容基地址变化（如日后迁移 CDN 域名）
   */
  private async countReferences(asset: {
    id: string;
    url: string;
    filename: string;
  }): Promise<number> {
    const urlFilter = {
      OR: [{ url: asset.url }, { url: { endsWith: `/${asset.filename}` } }],
    };
    const coverUrlFilter = {
      OR: [{ coverImageUrl: asset.url }, { coverImageUrl: { endsWith: `/${asset.filename}` } }],
    };

    const [productImages, blogCovers, blogCoverUrls] = await this.prisma.$transaction([
      this.prisma.productImage.count({ where: urlFilter }),
      this.prisma.blogPost.count({ where: { coverMediaId: asset.id } }),
      this.prisma.blogPost.count({ where: coverUrlFilter }),
    ]);

    return productImages + blogCovers + blogCoverUrls;
  }
}

/**
 * 原始文件名清洗：去目录成分（含 Windows 反斜杠）、控制字符，
 * 仅保留常见安全字符并限长。该值只用于展示，绝不参与路径拼接。
 */
function sanitizeOriginalName(originalName: string): string {
  const base = path
    .basename(originalName.replace(/\\/g, '/'))
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 0x20) // 去除控制字符（含 NUL）
    .join('');
  const safe = base.replace(/[^\p{L}\p{N}._-]/gu, '_');
  return (safe || 'unnamed').slice(0, ORIGINAL_NAME_MAX);
}
