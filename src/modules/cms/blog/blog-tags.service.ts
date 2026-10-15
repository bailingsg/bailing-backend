import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBlogTagDto, UpdateBlogTagDto } from './dto/blog-tag.dto';
import { toBlogTagDto, type BlogTagDto } from './entities/blog.entity';

/**
 * 博客标签管理（CMS）。
 *
 * 删除语义：删除标签会级联移除「文章↔标签」关联（BlogPostTag 由 schema 级联），
 * 文章本身不受影响。
 */
@Injectable()
export class BlogTagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 标签列表（含引用计数，按名称升序） */
  async list(): Promise<BlogTagDto[]> {
    const [tags, counts] = await Promise.all([
      this.prisma.blogTag.findMany({ orderBy: [{ name: 'asc' }] }),
      this.prisma.blogPostTag.groupBy({ by: ['tagId'], _count: { _all: true } }),
    ]);

    const countByTag = new Map(counts.map((c) => [c.tagId, c._count._all]));

    return tags.map((tag) => toBlogTagDto(tag, countByTag.get(tag.id) ?? 0));
  }

  /** 创建标签 */
  async create(dto: CreateBlogTagDto): Promise<BlogTagDto> {
    try {
      const created = await this.prisma.blogTag.create({
        data: { name: dto.name, slug: dto.slug },
      });
      return toBlogTagDto(created, 0);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 更新标签 */
  async update(id: string, dto: UpdateBlogTagDto): Promise<BlogTagDto> {
    const existing = await this.prisma.blogTag.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('博客标签不存在');

    try {
      const updated = await this.prisma.blogTag.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        },
      });

      const postCount = await this.prisma.blogPostTag.count({ where: { tagId: id } });
      return toBlogTagDto(updated, postCount);
    } catch (error) {
      throw this.mapWriteError(error, dto.slug);
    }
  }

  /** 删除标签（级联移除文章关联） */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.blogTag.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('博客标签不存在');

    await this.prisma.blogTag.delete({ where: { id } });
    return { id };
  }

  /** slug 唯一冲突 → 409；其余原样抛出 */
  private mapWriteError(error: unknown, slug?: string): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && slug) {
      return new ConflictException(`标签 slug 已存在: ${slug}`);
    }
    return error;
  }
}
