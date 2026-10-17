import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../revalidation/revalidation.service';
import { CmsTags } from '../../revalidation/cms-tags';
import {
  getPublishState,
  listEntityRevisions,
  previewEntity,
  publishEntity,
  requireText,
  saveEntityDraft,
  unpublishEntity,
  withPublishMeta,
  type PublishAdapter,
  type PublishState,
} from '../publishing/publishing.engine';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { AddProductImageDto } from './dto/product-image.dto';
import {
  PRODUCT_UPLOAD_DIR,
  UPLOAD_URL_PREFIX,
  safeFileNameFromUrl,
  verifyImageSignature,
} from './upload.options';
import {
  toCmsProductDetail,
  toCmsProductListItem,
  type CmsProductDetailDto,
  type CmsProductImageDto,
  type PaginatedCmsProductsDto,
  type ProductWithRelations,
} from './entities/product.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/** 产品列表/详情的关联加载 */
const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, slug: true } },
  images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.ProductInclude;

/**
 * 产品 CMS 服务。
 *
 * 删除语义：
 *   · 删除产品 → 先删除磁盘图片文件，再删数据库行（ProductImage 由 schema 级联）
 *   · 删除图片 → 先删行，再删文件；文件名经白名单校验，防路径穿越
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly revalidation: RevalidationService,
  ) {}

  /**
   * 产品变更后通知前台失效（Phase 4.8）。
   *
   * 同时失效列表 tag 与实体 tag：产品改名/换图会影响列表卡片，
   * 单个产品页也需要重新渲染。路径覆盖列表页与详情页。
   */
  private notifyFrontend(slug?: string): void {
    void this.revalidation.invalidate({
      tags: [CmsTags.products, ...(slug ? [CmsTags.product(slug)] : [])],
      // sitemap 含产品详情 URL，必须一并失效
      paths: ['/products', '/sitemap.xml', ...(slug ? [`/products/${slug}`] : [])],
    });
  }

  /** 上传图片的对外 URL 基地址（生产可指向 CDN 域名） */
  private get uploadsBaseUrl(): string {
    return this.config.getOrThrow<string>('uploadsBaseUrl').replace(/\/$/, '');
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 产品列表：分页 + keyword / status / categoryId 筛选 */
  async list(query: ListProductsQueryDto): Promise<PaginatedCmsProductsDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.ProductWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.keyword) {
      where.OR = [
        { name: { contains: query.keyword, mode: 'insensitive' } },
        { shortDescription: { contains: query.keyword, mode: 'insensitive' } },
        { description: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: (rows as ProductWithRelations[]).map(toCmsProductListItem),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 产品详情（编辑页数据源；不存在 404） */
  async findById(id: string): Promise<CmsProductDetailDto> {
    const product = await this.prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!product) throw new NotFoundException('产品不存在');
    return toCmsProductDetail(product as ProductWithRelations);
  }

  /* ------------------------------ 写入 ------------------------------ */

  /** 创建产品 */
  async create(dto: CreateProductDto): Promise<CmsProductDetailDto> {
    await this.assertCategoryExists(dto.categoryId);

    try {
      const created = await this.prisma.product.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          categoryId: dto.categoryId,
          shortDescription: dto.shortDescription ?? null,
          description: dto.description,
          material: dto.material ?? null,
          applications: dto.applications ? (dto.applications as Prisma.InputJsonValue) : Prisma.JsonNull,
          specifications: dto.specifications
            ? (dto.specifications as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          isFeatured: dto.isFeatured ?? false,
          // Phase 1：创建一律为草稿，发布只能经独立 publish 动作
          status: 'DRAFT',
          seoTitle: dto.seoTitle ?? null,
          seoDescription: dto.seoDescription ?? null,
        },
        include: PRODUCT_INCLUDE,
      });
      this.notifyFrontend(created.slug);
      return toCmsProductDetail(created as ProductWithRelations);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 从 Update DTO 构造 Prisma 更新数据（直接保存与「发布时应用编辑稿」共用） */
  private buildUpdateData(dto: UpdateProductDto): Prisma.ProductUpdateInput {
    const data: Prisma.ProductUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.categoryId !== undefined) data.category = { connect: { id: dto.categoryId } };
    if (dto.shortDescription !== undefined) data.shortDescription = dto.shortDescription;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.material !== undefined) data.material = dto.material;
    if (dto.applications !== undefined) {
      data.applications = dto.applications as Prisma.InputJsonValue;
    }
    if (dto.specifications !== undefined) {
      data.specifications = dto.specifications as Prisma.InputJsonValue;
    }
    if (dto.isFeatured !== undefined) data.isFeatured = dto.isFeatured;
    if (dto.seoTitle !== undefined) data.seoTitle = dto.seoTitle;
    if (dto.seoDescription !== undefined) data.seoDescription = dto.seoDescription;
    return data;
  }

  /** 更新产品（PATCH：仅更新提供的字段） */
  async update(
    id: string,
    dto: UpdateProductDto,
    ctx: { tx?: Prisma.TransactionClient; skipNotify?: boolean } = {},
  ): Promise<CmsProductDetailDto> {
    const db = ctx.tx ?? this.prisma;
    const existing = await this.prisma.product.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('产品不存在');

    if (dto.categoryId !== undefined) {
      await this.assertCategoryExists(dto.categoryId);
    }

    try {
      const updated = await db.product.update({
        where: { id },
        data: this.buildUpdateData(dto),
        include: PRODUCT_INCLUDE,
      });
      if (!ctx.skipNotify) this.notifyFrontend(updated.slug);
      return toCmsProductDetail(updated as ProductWithRelations);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /* --------------------------- 发布工作流 --------------------------- */

  /**
   * 发布适配器：把产品模块的字段映射 / 校验 / 快照接入通用引擎。
   *
   * 产品发布完整性校验（服务端强制，不依赖前端）：
   *   · name / slug / description 非空 —— 否则详情页与 SEO 无法成立
   *   · categoryId 必须指向存在的分类 —— 公开列表按分类筛选
   */
  private publishingAdapter(): PublishAdapter<ProductWithRelations> {
    return {
      entityType: 'PRODUCT',
      label: '产品',
      findRow: async (id) =>
        (await this.prisma.product.findUnique({
          where: { id },
          include: PRODUCT_INCLUDE,
        })) as ProductWithRelations | null,
      applyDraft: async (id, payload, tx) => {
        if (!payload) {
          const row = await tx.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
          if (!row) throw new NotFoundException('产品不存在');
          return row as ProductWithRelations;
        }
        const dto = payload as UpdateProductDto;
        if (dto.categoryId !== undefined) {
          const category = await tx.category.findUnique({
            where: { id: dto.categoryId },
            select: { id: true },
          });
          if (!category) {
            throw new BadRequestException('发布失败：编辑稿中的产品分类已不存在，请重新选择');
          }
        }
        return tx.product.update({
          where: { id },
          data: this.buildUpdateData(dto),
          include: PRODUCT_INCLUDE,
        }) as Promise<ProductWithRelations>;
      },
      markPublished: async (id, nextVersion, tx) =>
        tx.product.update({
          where: { id },
          data: {
            status: 'PUBLISHED',
            // Product 模型无 publishedAt 字段（历史原因），发布时间以
            // ContentRevision.publishedAt 为准，公开站 SEO 不依赖该字段。
            version: { increment: 1 },
            publishedVersion: nextVersion,
          },
          include: PRODUCT_INCLUDE,
        }) as Promise<ProductWithRelations>,
      markUnpublished: async (id, tx) =>
        tx.product.update({
          where: { id },
          data: { status: 'UNPUBLISHED', version: { increment: 1 } },
          include: PRODUCT_INCLUDE,
        }) as Promise<ProductWithRelations>,
      validate: (row) => {
        requireText(row.name, '产品名称', '产品');
        requireText(row.slug, 'URL 别名（slug）', '产品');
        requireText(row.description, '产品描述', '产品');
        if (!row.category) {
          throw new BadRequestException('发布失败：产品必须归属一个分类');
        }
      },
      toSnapshot: (row) => toCmsProductDetail(row),
    };
  }

  /** 发布状态快照（供控制器决定「直接改行」还是「写编辑稿」） */
  publishState(id: string): Promise<PublishState> {
    return getPublishState(this.prisma, this.publishingAdapter(), id);
  }

  /** 保存编辑稿（已发布产品不再直接改写线上行） */
  saveDraft(
    id: string,
    dto: UpdateProductDto,
    actorId: string | null,
    expectedVersion?: number,
  ): Promise<{ draftVersion: number; updatedAt: Date; baseVersion: number }> {
    return saveEntityDraft(
      this.prisma,
      this.publishingAdapter(),
      id,
      dto as Record<string, unknown>,
      actorId,
      expectedVersion,
    );
  }

  /** 发布：把编辑稿应用为线上版本（事务内完成，失败不影响旧版本） */
  async publish(id: string, actorId: string | null): Promise<CmsProductDetailDto> {
    const result = await publishEntity(this.prisma, this.publishingAdapter(), id, actorId);
    this.notifyFrontend(result.row.slug);
    return withPublishMeta(toCmsProductDetail(result.row), result);
  }

  /** 取消发布：保留内容与历史，公开侧立即不可见 */
  async unpublish(id: string): Promise<CmsProductDetailDto> {
    const result = await unpublishEntity(this.prisma, this.publishingAdapter(), id);
    this.notifyFrontend(result.row.slug);
    return withPublishMeta(toCmsProductDetail(result.row), result);
  }

  /** 预览：线上版本 + 编辑稿（仅后台授权访问） */
  preview(id: string) {
    return previewEntity(this.prisma, this.publishingAdapter(), id, (row) =>
      toCmsProductDetail(row),
    );
  }

  /** 发布历史 */
  revisions(id: string) {
    return listEntityRevisions(this.prisma, this.publishingAdapter(), id);
  }

  /**
   * 删除产品：先清理磁盘图片文件，再删除数据库行
   * （ProductImage 由 schema 的 onDelete: Cascade 级联删除）。
   */
  async remove(id: string): Promise<{ id: string }> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { images: { select: { url: true } } },
    });
    if (!product) throw new NotFoundException('产品不存在');

    for (const image of product.images) {
      await this.deleteImageFile(image.url);
    }

    // 发布工作流的附属数据没有外键（通用表按 entityType+entityId 关联），
    // 必须在删除主体时一并清理，避免留下孤儿编辑稿与历史快照。
    await this.prisma.$transaction([
      this.prisma.contentDraft.deleteMany({ where: { entityType: 'PRODUCT', entityId: id } }),
      this.prisma.contentRevision.deleteMany({ where: { entityType: 'PRODUCT', entityId: id } }),
      this.prisma.product.delete({ where: { id } }),
    ]);
    // 删除后前台必须立即 404：同时失效列表 tag 与（已删除的）详情页路径。
    this.notifyFrontend(product.slug);
    return { id };
  }

  /* ------------------------------ 图片 ------------------------------ */

  /**
   * 上传产品图片（文件已由 multer 拦截器落盘到 uploads/products）。
   * 流程：产品存在性 → 魔数校验（失败即删文件）→ 写库 → 返回。
   */
  async addImage(
    productId: string,
    file: { path: string; mimetype: string; size: number },
    dto: AddProductImageDto,
  ): Promise<CmsProductImageDto> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, _count: { select: { images: true } } },
    });
    if (!product) {
      await this.safeUnlink(file.path);
      throw new NotFoundException('产品不存在');
    }

    // 魔数校验：扩展名/MIME 可伪造，内容特征不可轻易伪造
    if (!(await verifyImageSignature(file.path, file.mimetype))) {
      await this.safeUnlink(file.path);
      throw new BadRequestException('文件内容不是受支持的图片格式（jpeg / png / webp / avif）');
    }

    const fileName = path.basename(file.path);
    const url = `${this.uploadsBaseUrl}${UPLOAD_URL_PREFIX}/${fileName}`;
    // 首图默认设为主图（保证公开站列表卡片始终有图）
    const isPrimary = dto.isPrimary ?? product._count.images === 0;

    try {
      if (isPrimary) {
        // 主图唯一：先清旧主图标记，再写入新主图
        await this.prisma.productImage.updateMany({
          where: { productId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      const image = await this.prisma.productImage.create({
        data: {
          productId,
          url,
          altText: dto.alt ?? null,
          sortOrder: dto.sortOrder ?? 0,
          isPrimary,
        },
      });

      // 新增图片会影响产品详情页与列表卡片，通知前台失效
      const owner = await this.prisma.product.findUnique({
        where: { id: productId },
        select: { slug: true },
      });
      this.notifyFrontend(owner?.slug);

      return {
        id: image.id,
        url: image.url,
        altText: image.altText,
        sortOrder: image.sortOrder,
        isPrimary: image.isPrimary,
        createdAt: image.createdAt.toISOString(),
      };
    } catch (error) {
      // 写库失败时清理已落盘文件，避免磁盘垃圾
      await this.safeUnlink(file.path);
      throw error;
    }
  }

  /** 删除产品图片：先删行，再删磁盘文件（失败不阻断，仅记录） */
  async removeImage(productId: string, imageId: string): Promise<{ id: string }> {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
      select: { id: true, url: true, isPrimary: true },
    });
    if (!image) throw new NotFoundException('图片不存在');

    await this.prisma.productImage.delete({ where: { id: image.id } });
    await this.deleteImageFile(image.url);

    // 若删除的是主图且仍有其他图片，把最早的一张提升为主图
    if (image.isPrimary) {
      const next = await this.prisma.productImage.findFirst({
        where: { productId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      if (next) {
        await this.prisma.productImage.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }

    // 图片变更会影响产品详情页展示，通知前台失效（含该产品详情路径）
    const owner = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { slug: true },
    });
    this.notifyFrontend(owner?.slug);

    return { id: image.id };
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new BadRequestException('分类不存在，请先创建或选择有效分类');
  }

  /** 按存储 URL 删除文件（文件名白名单校验 + 目录约束，防路径穿越） */
  private async deleteImageFile(url: string): Promise<void> {
    const fileName = safeFileNameFromUrl(url);
    if (!fileName) return;
    await this.safeUnlink(path.join(PRODUCT_UPLOAD_DIR, fileName));
  }

  /** 静默删除（文件不存在不抛错） */
  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      /* 文件不存在或已删除：忽略 */
    }
  }

  /** slug 唯一冲突 → 409；P2025 → 404；其余包装 500 */
  private mapWriteError(error: unknown, slug?: string): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002' && slug) {
        return new ConflictException(`产品 slug 已存在: ${slug}`);
      }
      if (error.code === 'P2025') {
        return new NotFoundException('产品不存在');
      }
    }
    return new InternalServerErrorException('写入失败，请稍后重试');
  }
}
