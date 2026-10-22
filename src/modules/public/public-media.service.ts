import { Injectable } from '@nestjs/common';
import { MediaUsage, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicMediaListQueryDto } from './dto/public-media-query.dto';

/** 公开媒体项（与 CMS 的 MediaAssetDto 不同：不暴露任何内部字段） */
export interface PublicMediaItem {
  id: string;
  url: string;
  altText: string | null;
  title: string | null;
  caption: string | null;
  usage: MediaUsage;
  createdAt: string;
}

const DEFAULT_LIMIT = 24;

/**
 * 公开媒体只读服务（Phase 5.6）。
 *
 * 用途：让前台页面按「用途分类」自动聚合图片——媒体库上传时选了
 * 工厂 / 生产 / 装车 / 展会等用途，页面无需在业务表里重复登记即可取到。
 *
 * 边界（与其它公开接口一致）：
 *   · 不暴露 storageKey / createdBy / provider / size 等内部字段
 *   · 不返回「未分类」（usage 为 null）的资产——未分类不进任何公开页面
 *   · 数量有上限（默认 24 / 最大 48），保护公开端
 */
@Injectable()
export class PublicMediaService {
  constructor(private readonly prisma: PrismaService) {}

  /** 按用途列出媒体（不传 usage 时返回全部已分类媒体） */
  async list(query: PublicMediaListQueryDto): Promise<{ items: PublicMediaItem[]; total: number }> {
    const limit = Math.min(48, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.MediaAssetWhereInput = { usage: { not: null } };
    if (query.usage) where.usage = query.usage;

    const rows = await this.prisma.mediaAsset.findMany({
      where,
      // 最新上传在前（媒体库列表同口径），同秒按 id 稳定排序
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        url: true,
        altText: true,
        title: true,
        caption: true,
        usage: true,
        createdAt: true,
      },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        url: row.url,
        altText: row.altText,
        title: row.title,
        caption: row.caption,
        usage: row.usage as MediaUsage,
        createdAt: row.createdAt.toISOString(),
      })),
      total: rows.length,
    };
  }
}
