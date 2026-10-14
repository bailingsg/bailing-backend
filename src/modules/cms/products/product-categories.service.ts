import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { CmsCategoryDto } from './entities/product.entity';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

/**
 * 产品分类管理（CMS）。
 *
 * 删除保护：分类下存在产品时禁止删除（数据库层 Product.category 为
 * onDelete: Restrict，服务层提前给出友好错误）。
 */
@Injectable()
export class ProductCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 分类列表（含各分类产品计数，按 sortOrder 升序） */
  async list(): Promise<CmsCategoryDto[]> {
    const [categories, counts] = await Promise.all([
      this.prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.product.groupBy({ by: ['categoryId'], _count: { _all: true } }),
    ]);

    const countByCategory = new Map(counts.map((c) => [c.categoryId, c._count._all]));

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      productCount: countByCategory.get(category.id) ?? 0,
      createdAt: category.createdAt.toISOString(),
      updatedAt: category.updatedAt.toISOString(),
    }));
  }

  /** 创建分类 */
  async create(dto: CreateCategoryDto): Promise<CmsCategoryDto> {
    try {
      const created = await this.prisma.category.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          description: dto.description ?? null,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        },
      });
      return this.toDto(created, 0);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 更新分类 */
  async update(id: string, dto: UpdateCategoryDto): Promise<CmsCategoryDto> {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('分类不存在');

    try {
      const updated = await this.prisma.category.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      const productCount = await this.prisma.product.count({ where: { categoryId: id } });
      return this.toDto(updated, productCount);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /**
   * 删除分类。分类下存在产品时拒绝（与数据库 RESTRICT 语义一致的友好提示）。
   */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('分类不存在');

    const productCount = await this.prisma.product.count({ where: { categoryId: id } });
    if (productCount > 0) {
      throw new BadRequestException(`该分类下还有 ${productCount} 个产品，请先移动或删除这些产品`);
    }

    await this.prisma.category.delete({ where: { id } });
    return { id };
  }

  /** slug 唯一冲突 → 409；其余原样抛出 */
  private mapWriteError(error: unknown, slug?: string): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      slug
    ) {
      return new ConflictException(`分类 slug 已存在: ${slug}`);
    }
    return error;
  }

  private toDto(
    category: { id: string; name: string; slug: string; description: string | null; sortOrder: number; isActive: boolean; createdAt: Date; updatedAt: Date },
    productCount: number,
  ): CmsCategoryDto {
    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      productCount,
      createdAt: category.createdAt.toISOString(),
      updatedAt: category.updatedAt.toISOString(),
    };
  }
}
