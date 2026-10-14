import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import {
  PaginatedProductsDto,
  ProductDetailDto,
  toProductDetail,
  toProductListItem,
} from './product.dto';

const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 48;

/** 列表/详情共用的关联加载：分类 + 图片 */
const productInclude = {
  category: true,
  images: true,
} satisfies Prisma.ProductInclude;

/**
 * 产品查询服务（只读）。
 *
 * 对外只暴露 status = PUBLISHED 的产品；DRAFT / ARCHIVED 一律不可见，
 * 保证后台草稿不会泄漏到公开站点。
 */
@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 产品列表：支持分页、分类过滤、精选过滤 */
  async list(query: ListProductsQueryDto): Promise<PaginatedProductsDto> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.ProductWhereInput = { status: ProductStatus.PUBLISHED };

    if (query.category) {
      where.category = { slug: query.category, isActive: true };
    }
    if (query.featured !== undefined) {
      where.isFeatured = query.featured === 'true';
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include: productInclude,
        // 精选优先，其次按更新时间倒序，保证分页结果稳定
        orderBy: [{ isFeatured: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map(toProductListItem),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /** 产品详情：按 slug 查询，未发布或不存在统一 404（不区分，避免探测） */
  async findBySlug(slug: string): Promise<ProductDetailDto> {
    const product = await this.prisma.product.findFirst({
      where: { slug, status: ProductStatus.PUBLISHED },
      include: productInclude,
    });

    if (!product) {
      throw new NotFoundException(`Product not found`);
    }

    return toProductDetail(product);
  }
}
