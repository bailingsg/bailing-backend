import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBlogCategoryDto, UpdateBlogCategoryDto } from './dto/blog-category.dto';
import { toBlogCategoryDto, type BlogCategoryDto } from './entities/blog.entity';

/**
 * 博客分类管理（CMS）。
 *
 * 删除保护：分类下存在文章时拒绝删除（数据库层为 onDelete: SetNull，
 * 服务层提前给出友好提示，避免内容静默丢失分类归属）。
 */
@Injectable()
export class BlogCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 分类列表（含各分类文章计数，按 sortOrder 升序） */
  async list(): Promise<BlogCategoryDto[]> {
    const [categories, counts] = await Promise.all([
      this.prisma.blogCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.blogPost.groupBy({ by: ['categoryId'], _count: { _all: true } }),
    ]);

    const countByCategory = new Map(
      counts.filter((c) => c.categoryId !== null).map((c) => [c.categoryId as string, c._count._all]),
    );

    return categories.map((category) =>
      toBlogCategoryDto(category, countByCategory.get(category.id) ?? 0),
    );
  }

  /** 创建分类 */
  async create(dto: CreateBlogCategoryDto): Promise<BlogCategoryDto> {
    try {
      const created = await this.prisma.blogCategory.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          description: dto.description ?? null,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        },
      });
      return toBlogCategoryDto(created, 0);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 更新分类 */
  async update(id: string, dto: UpdateBlogCategoryDto): Promise<BlogCategoryDto> {
    const existing = await this.prisma.blogCategory.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('博客分类不存在');

    try {
      const updated = await this.prisma.blogCategory.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      const postCount = await this.prisma.blogPost.count({ where: { categoryId: id } });
      return toBlogCategoryDto(updated, postCount);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 删除分类：分类下存在文章时拒绝（提示改用「禁用」或先迁移文章） */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.blogCategory.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('博客分类不存在');

    const postCount = await this.prisma.blogPost.count({ where: { categoryId: id } });
    if (postCount > 0) {
      throw new BadRequestException(
        `该分类下还有 ${postCount} 篇文章，请先迁移这些文章，或将分类设为「禁用」`,
      );
    }

    await this.prisma.blogCategory.delete({ where: { id } });
    return { id };
  }

  /** slug 唯一冲突 → 409；其余原样抛出 */
  private mapWriteError(error: unknown, slug?: string): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && slug) {
      return new ConflictException(`分类 slug 已存在: ${slug}`);
    }
    return error;
  }
}
