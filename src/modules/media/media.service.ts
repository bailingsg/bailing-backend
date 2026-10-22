import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MediaCategory, MediaUsage, Prisma } from '@prisma/client';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidationService } from '../revalidation/revalidation.service';
import {
  ALL_SITE_PATHS,
  CmsTags,
  MEDIA_DEPENDENT_TAGS,
} from '../revalidation/cms-tags';
import { ListMediaQueryDto } from './dto/list-media-query.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import {
  isDocumentMime,
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
    private readonly revalidation: RevalidationService,
  ) {}

  /**
   * 媒体变更后通知前台（Phase 5.6）。
   *
   * 媒体被产品 / 博客 / 工厂 / 质量 / 应用 / 站点分区共同引用，
   * 且前台 /factory 等页面按**用途分类**自动聚合媒体库图片——
   * 因此上传 / 改用途 / 删除都要按「全内容」范围失效。
   * 通知失败只记警告，不影响已成功的写入。
   */
  private notifyFrontend(): void {
    void this.revalidation.invalidate({
      tags: [...MEDIA_DEPENDENT_TAGS],
      paths: [...ALL_SITE_PATHS, '/sitemap.xml'],
    });
  }

  /* ------------------------------ 上传 ------------------------------ */

  /**
   * 上传媒体（控制器以内存存储接收文件，本服务完成校验并委托 StorageProvider 落盘）。
   * 流程：MIME/大小校验 → 魔数校验 → 尺寸解析 → Provider 上传 → 落库。
   *
   * usage 为业务用途分类（文章 / 产品 / 证书 / 工厂 …），缺省表示「未分类」。
   */
  async upload(
    file: Express.Multer.File,
    userId: string,
    usage?: MediaUsage,
  ): Promise<MediaAssetDto> {
    validateUpload(file);

    if (!verifyImageSignature(file.buffer, file.mimetype)) {
      throw new BadRequestException(
        '文件内容与声明格式不符（支持 jpeg / png / webp / avif / pdf，须通过魔数校验）',
      );
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
        // 文档（PDF）与图片分属不同 MediaCategory，供业务侧筛选与前台展示区分
        category: isDocumentMime(file.mimetype) ? MediaCategory.DOCUMENT : MediaCategory.IMAGE,
        // 业务用途分类（Phase 5.6）：上传时选择，后续可在媒体库/SEO 编辑中修改
        usage: usage ?? null,
        provider: this.storage.provider,
        createdBy: userId,
      },
    });

    // Phase 5.6：新图可能被 /factory 等页面按用途自动聚合，通知前台刷新
    this.notifyFrontend();
    return toMediaAssetDto(asset);
  }

  /* ------------------------------ 查询 ------------------------------ */
  /** 媒体列表：分页 + keyword（originalName/filename）+ category / usage 筛选 */
  async list(query: ListMediaQueryDto): Promise<PaginatedMediaDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.MediaAssetWhereInput = {};
    if (query.category) where.category = query.category;
    if (query.usage) where.usage = query.usage;
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
  /**
   * 更新媒体元数据（Phase 5.0 图片 SEO：alt / title / caption / description；
   * Phase 5.6 追加用途分类 usage）。
   * 仅更新显式传入的字段；空串 = 清除该字段。
   */
  async updateMetadata(id: string, dto: UpdateMediaDto): Promise<MediaAssetDto> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) {
      throw new NotFoundException('媒体资源不存在');
    }

    const data: Prisma.MediaAssetUpdateInput = {};
    if (dto.altText !== undefined) data.altText = dto.altText === '' ? null : dto.altText;
    if (dto.title !== undefined) data.title = dto.title === '' ? null : dto.title;
    if (dto.caption !== undefined) data.caption = dto.caption === '' ? null : dto.caption;
    if (dto.description !== undefined) data.description = dto.description === '' ? null : dto.description;
    // usage：null / 空串已由 DTO 归一化为 null（= 未分类），有值则直接覆盖
    if (dto.usage !== undefined) data.usage = dto.usage;

    const updated = await this.prisma.mediaAsset.update({ where: { id }, data });
    // 用途 / SEO 元数据变化会影响前台按用途聚合的图集
    this.notifyFrontend();
    return toMediaAssetDto(updated);
  }

  async remove(id: string): Promise<{ id: string }> {    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('媒体资源不存在');

    const referenced = await this.countReferences(asset);
    if (referenced > 0) {
      throw new BadRequestException('Media asset is in use.');
    }

    await this.prisma.mediaAsset.delete({ where: { id } });
    await this.storage.delete(asset.storageKey);
    // 删除会影响所有引用该图的页面
    this.notifyFrontend();
    return { id };
  }

  /**
   * 引用计数：业务表中引用该资产的记录数。
   *
   * 覆盖范围：
   *   · ProductImage.url —— 产品图片（Phase 4.3 起）
   *   · BlogPost.coverMediaId / coverImageUrl —— 博客封面（Phase 4.4 起）
   *   · FactorySection.coverMediaId / coverImageUrl —— 工厂分区封面（Phase 4.5）
   *   · FactoryImage.mediaId —— 工厂图库 / 展会照片（Phase 4.5）
   *   · QualityRecord.mediaId —— 质量证书 / 报告（Phase 4.5）
   *   · Application.coverMediaId / coverImageUrl —— 应用场景封面（Phase 4.5）
   *   · SiteSection.mediaId —— 站点结构化内容分区配图（Phase 4.7）
   *
   * 匹配策略（外键 id 优先，url 精确 + 文件名后缀双保险）：
   *   · 外键字段（*MediaId）直接按 id 计数——最可靠，不受地址变化影响
   *   · url 精确相等——同一 Provider 生成的地址一致
   *   · url 以 /<filename> 结尾——兼容基地址变化（如日后迁移 CDN 域名）
   *
   * 说明：任一命中即视为「被引用」，因此各来源数量**可重复计**（同一资产的
   * url 与 filename 可能同时命中同一行），此处只关心「是否 > 0」，故直接求和。
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

    const counts = await this.prisma.$transaction([
      // Phase 4.3 产品图片
      this.prisma.productImage.count({ where: urlFilter }),
      // Phase 4.4 博客封面
      this.prisma.blogPost.count({ where: { coverMediaId: asset.id } }),
      this.prisma.blogPost.count({ where: coverUrlFilter }),
      // Phase 4.5 工厂分区封面（外键 + 地址快照）
      this.prisma.factorySection.count({ where: { coverMediaId: asset.id } }),
      this.prisma.factorySection.count({ where: coverUrlFilter }),
      // Phase 4.5 工厂图库 / 展会照片（外键）
      this.prisma.factoryImage.count({ where: { mediaId: asset.id } }),
      // Phase 4.5 质量证书 / 报告（外键）
      this.prisma.qualityRecord.count({ where: { mediaId: asset.id } }),
      // Phase 4.5 应用场景封面（外键 + 地址快照）
      this.prisma.application.count({ where: { coverMediaId: asset.id } }),
      this.prisma.application.count({ where: coverUrlFilter }),
      // Phase 4.7 站点结构化内容分区配图（外键）
      this.prisma.siteSection.count({ where: { mediaId: asset.id } }),
    ]);

    return counts.reduce((sum, value) => sum + value, 0);
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
