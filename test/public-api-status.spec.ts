import { NotFoundException } from '@nestjs/common';
import { ContentStatus, PostStatus } from '@prisma/client';
import { PublicBlogService } from '../src/modules/public/public-blog.service';
import { PublicSiteService, PublicNavService } from '../src/modules/public/public-site.service';
import { toPublicBlogPostDetail, toPublicBlogPostSummary } from '../src/modules/public/entities/public.entity';
import type { PrismaService } from '../src/modules/prisma/prisma.service';

/**
 * 公开 API 状态隔离测试（Phase 4.7）。
 *
 * 对应任务书「公开 API Draft 泄漏测试」——硬约束逐条验证：
 *   · 各公开端点只返回 PUBLISHED（草稿 / 归档不可见）
 *   · 未发布 slug 的详情请求返回 404（不区分「不存在」与「未发布」）
 *   · DTO 白名单：不透出 storageKey / createdBy / provider / status / sortOrder / authorId
 *   · 导航只返回启用项
 *
 * 数据库不参与：PrismaService 以 jest mock 替换。
 */

const BLOG_ROW = {
  id: 'post-1',
  title: 'How to choose MDF thickness',
  slug: 'choose-mdf-thickness',
  excerpt: 'A practical guide.',
  content: '<p>Thickness matters.</p>',
  coverImageUrl: null,
  coverMediaId: null,
  categoryId: null,
  status: PostStatus.PUBLISHED,
  featured: false,
  publishedAt: new Date('2026-10-01T00:00:00.000Z'),
  authorId: 'admin-1',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  category: null,
  tags: [],
  coverMedia: null,
};

describe('公开 API 状态隔离（Draft / Archived 不得泄漏）', () => {
  /* ------------------------------ Blog ------------------------------ */

  describe('博客公开 API', () => {
    it('列表查询只过滤 PUBLISHED', async () => {
      const blogPost = {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      };
      const prisma = {
        blogPost,
        blogCategory: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
      };
      const service = new PublicBlogService(prisma as unknown as PrismaService);

      await service.list({} as never);

      expect(blogPost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: PostStatus.PUBLISHED } }),
      );
    });

    it('草稿 / 归档文章的 slug 详情一律 404（不泄漏存在性）', async () => {
      const prisma = {
        blogPost: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(),
      };
      const service = new PublicBlogService(prisma as unknown as PrismaService);

      await expect(service.findBySlug('draft-post')).rejects.toThrow(NotFoundException);
      expect(prisma.blogPost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'draft-post', status: PostStatus.PUBLISHED },
        }),
      );
    });

    it('分类列表只统计已发布文章', async () => {
      const blogCategory = { findMany: jest.fn().mockResolvedValue([]) };
      const prisma = { blogCategory, $transaction: jest.fn() };
      const service = new PublicBlogService(prisma as unknown as PrismaService);

      await service.categories();

      expect(blogCategory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            _count: { select: { posts: { where: { status: PostStatus.PUBLISHED } } } },
          },
        }),
      );
    });

    it('博客响应 DTO 不含内部字段（authorId / storageKey / status / createdBy）', () => {
      const dto = toPublicBlogPostDetail(BLOG_ROW as never) as unknown as Record<string, unknown>;
      for (const forbidden of [
        'authorId',
        'storageKey',
        'createdBy',
        'provider',
        'status',
        'sortOrder',
        'id',
        'categoryId',
        'coverMediaId',
        'ogTitle',
        'twitterTitle',
      ]) {
        expect(dto).not.toHaveProperty(forbidden);
      }
      expect(dto).toHaveProperty('contentHtml');
      expect(dto).toHaveProperty('readingMinutes');
    });

    it('阅读时长估算：中文按字、英文按词，至少 1 分钟', () => {
      expect(toPublicBlogPostSummary({ ...BLOG_ROW, content: '木板' } as never).readingMinutes).toBe(1);
      const long = 'word '.repeat(600);
      expect(toPublicBlogPostSummary({ ...BLOG_ROW, content: long } as never).readingMinutes).toBe(3);
    });
  });

  /* --------------------------- 站点内容 / 导航 --------------------------- */

  describe('站点内容与导航公开 API', () => {
    it('分区查询只返回 PUBLISHED', async () => {
      const siteSection = { findMany: jest.fn().mockResolvedValue([]) };
      const prisma = { siteSection };
      const service = new PublicSiteService(prisma as unknown as PrismaService);

      await service.sectionsByPage('HOME' as never);

      expect(siteSection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { page: 'HOME', status: ContentStatus.PUBLISHED },
        }),
      );
    });

    it('未发布分区按 page+key 查询返回 404', async () => {
      const siteSection = { findFirst: jest.fn().mockResolvedValue(null) };
      const prisma = { siteSection };
      const service = new PublicSiteService(prisma as unknown as PrismaService);

      await expect(
        service.sectionByKey('HOME' as never, 'home.draft-hero'),
      ).rejects.toThrow(NotFoundException);
    });

    it('导航只返回启用项', async () => {
      const navItem = { findMany: jest.fn().mockResolvedValue([]) };
      const prisma = { navItem };
      const service = new PublicNavService(prisma as unknown as PrismaService);

      await service.items('HEADER');

      expect(navItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { location: 'HEADER', isActive: true },
        }),
      );
    });
  });
});
