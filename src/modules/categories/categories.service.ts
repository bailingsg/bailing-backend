import { Injectable } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** 分类对外契约（稳定结构） */
export interface CategoryDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  sortOrder: number;
  /** 该分类下已发布产品数量，供前端筛选器展示 */
  productCount: number;
}

export interface CategoryListDto {
  items: CategoryDto[];
  total: number;
}

/**
 * 产品分类查询服务（只读）。
 *
 * 分类体系不写死在代码里：完全由数据库驱动，
 * 未来 CMS 阶段可直接维护分类树（parentId 已为多级预留）。
 * 当前允许空数据，前端需处理"无分类"状态。
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<CategoryListDto> {
    const categories = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { products: { where: { status: ProductStatus.PUBLISHED } } },
        },
      },
    });

    return {
      items: categories.map((category) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        description: category.description,
        parentId: category.parentId,
        sortOrder: category.sortOrder,
        productCount: category._count.products,
      })),
      total: categories.length,
    };
  }
}
