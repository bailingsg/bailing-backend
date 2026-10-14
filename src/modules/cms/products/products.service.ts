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
  ) {}

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
          status: dto.status ?? 'DRAFT',
          seoTitle: dto.seoTitle ?? null,
          seoDescription: dto.seoDescription ?? null,
        },
        include: PRODUCT_INCLUDE,
      });
      return toCmsProductDetail(created as ProductWithRelations);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 更新产品（PATCH：仅更新提供的字段） */
  async update(id: string, dto: UpdateProductDto): Promise<CmsProductDetailDto> {
    const existing = await this.prisma.product.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('产品不存在');

    if (dto.categoryId !== undefined) {
      await this.assertCategoryExists(dto.categoryId);
    }

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
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.seoTitle !== undefined) data.seoTitle = dto.seoTitle;
    if (dto.seoDescription !== undefined) data.seoDescription = dto.seoDescription;

    try {
      const updated = await this.prisma.product.update({
        where: { id },
        data,
        include: PRODUCT_INCLUDE,
      });
      return toCmsProductDetail(updated as ProductWithRelations);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
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

    await this.prisma.product.delete({ where: { id } });
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
