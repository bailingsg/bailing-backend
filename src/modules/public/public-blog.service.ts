import { Injectable, NotFoundException } from '@nestjs/common';
import { PostStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicBlogListQueryDto } from './dto/public-list-query.dto';
import {
  PublicBlogCategory,
  toPublicBlogPostDetail,
  toPublicBlogPostSummary,
} from './entities/public.entity';

const BLOG_PUBLIC_INCLUDE = {
  category: true,
  tags: { include: { tag: true } },
  coverMedia: true,
} satisfies Prisma.BlogPostInclude;

const DEFAULT_PAGE_SIZE = 9;
const MAX_PAGE_SIZE = 24;

/**
 * 博客公开只读服务（Phase 4.7）。
 *
 * 发布规则（硬约束，与 Factory / Quality / Applications 一致）：
 *   · **只返回 status = PUBLISHED** 的文章；草稿 / 归档一律不可见
 *   · 未发布文章的 slug 详情请求返回 404（不区分「不存在」与「未发布」，
 *     避免探测内容存在性）
 *   · 分类列表只统计已发布文章数（草稿 / 归档不计入）
 *   · DTO 白名单映射，不透出 authorId / 内部字段（见 public.entity.ts）
 *
 * 分页上限比 CMS 更保守（24）：公开端点优先保护后端。
 */
@Injectable()
export class PublicBlogService {
  constructor(private readonly prisma: PrismaService) {}

  /** 公开文章列表（分页 / 分类 / 标签 / 精选筛选） */
  async list(query: PublicBlogListQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.BlogPostWhereInput = { status: PostStatus.PUBLISHED };
    if (query.category) {
      where.category = { slug: query.category, isActive: true };
    }
    if (query.tag) {
      where.tags = { some: { tag: { slug: query.tag } } };
    }
    if (query.featured === 'true') where.featured = true;
    else if (query.featured === 'false') where.featured = false;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.blogPost.count({ where }),
      this.prisma.blogPost.findMany({
        where,
        include: BLOG_PUBLIC_INCLUDE,
        // 发布日期倒序（无发布日期的排最后），同日期按标题稳定排序
        orderBy: [{ publishedAt: 'desc' }, { title: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map(toPublicBlogPostSummary),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** 公开文章详情（按 slug）——非 PUBLISHED 一律 404，不泄漏存在性 */
  async findBySlug(slug: string) {
    const row = await this.prisma.blogPost.findFirst({
      where: { slug, status: PostStatus.PUBLISHED },
      include: BLOG_PUBLIC_INCLUDE,
    });
    if (!row) throw new NotFoundException('Blog post not found.');
    return toPublicBlogPostDetail(row);
  }

  /** 公开分类列表（含已发布文章数） */
  async categories(): Promise<{ items: PublicBlogCategory[] }> {
    const rows = await this.prisma.blogCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { posts: { where: { status: PostStatus.PUBLISHED } } },
        },
      },
    });

    return {
      items: rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        description: row.description,
        postCount: row._count.posts,
      })),
    };
  }
}
