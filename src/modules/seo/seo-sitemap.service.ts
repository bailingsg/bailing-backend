import { Injectable } from '@nestjs/common';
import { ContentStatus, PostStatus, ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SeoSettingsService } from './seo-settings.service';
import { STATIC_PAGES } from './seo.constants';
import { SeoSitemapEntry } from './entities/seo.entity';

/**
 * Sitemap / Robots 生成器（任务书二十一~二十三节）
 *
 * Sitemap 规则（硬性）：
 *   · 只收录**已发布**内容（后端公开接口同源：草稿 / 归档天然排除）；
 *   · 显式 noindex 的实体一律排除（与 robots 语义一致，杜绝「sitemap 收录
 *     禁止索引页面」的矛盾）；
 *   · 绝不包含 /admin、/login、/search、/api；
 *   · 内容新增 / 发布 / 更新后由 revalidate 即时反映（sitemap.xml 挂 seo tag）。
 */
@Injectable()
export class SeoSitemapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SeoSettingsService,
  ) {}

  async getEntries(): Promise<SeoSitemapEntry[]> {
    const entries: SeoSitemapEntry[] = [];
    const now = new Date();

    // —— 静态页面（读取 noindex 档案）——
    const pageProfiles = await this.prisma.seoProfile.findMany({
      where: { entityType: 'PAGE' },
    });
    const noindexPages = new Set(
      pageProfiles.filter((p) => !p.robotsIndex).map((p) => p.entityId),
    );
    for (const page of STATIC_PAGES) {
      if (noindexPages.has(page.key)) continue;
      entries.push({
        path: page.route,
        lastModified: now.toISOString(),
        changeFrequency: page.route === '/' ? 'weekly' : 'monthly',
        priority: page.route === '/' ? 1.0 : page.route === '/products' ? 0.9 : 0.8,
      });
    }

    // —— 产品（仅 PUBLISHED，且未显式 noindex）——
    const products = await this.prisma.product.findMany({
      where: { status: ProductStatus.PUBLISHED },
      select: { id: true, slug: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    const productNoindex = await this.noindexIds('PRODUCT', products.map((p) => p.id));
    for (const p of products) {
      if (productNoindex.has(p.id)) continue;
      entries.push({
        // 前台详情路由以产品 id 拼接（/products/[id]）
        path: `/products/${p.id}`,
        lastModified: p.updatedAt.toISOString(),
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }

    // —— 产品分类（isActive）——
    const categories = await this.prisma.category.findMany({
      where: { isActive: true },
      select: { id: true, slug: true, updatedAt: true },
    });
    const categoryNoindex = await this.noindexIds('PRODUCT_CATEGORY', categories.map((c) => c.id));
    for (const c of categories) {
      if (categoryNoindex.has(c.id)) continue;
      entries.push({
        path: `/products/category/${c.slug}`,
        lastModified: c.updatedAt.toISOString(),
        changeFrequency: 'weekly',
        priority: 0.6,
      });
    }

    // —— 博客文章（仅 PUBLISHED）——
    const posts = await this.prisma.blogPost.findMany({
      where: { status: PostStatus.PUBLISHED },
      select: { id: true, slug: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    const postNoindex = await this.noindexIds('BLOG_POST', posts.map((p) => p.id));
    for (const p of posts) {
      if (postNoindex.has(p.id)) continue;
      entries.push({
        path: `/blog/${p.slug}`,
        lastModified: p.updatedAt.toISOString(),
        changeFrequency: 'monthly',
        priority: 0.6,
      });
    }

    // —— 博客分类（isActive）——
    const blogCategories = await this.prisma.blogCategory.findMany({
      where: { isActive: true },
      select: { id: true, slug: true, updatedAt: true },
    });
    const blogCategoryNoindex = await this.noindexIds('BLOG_CATEGORY', blogCategories.map((c) => c.id));
    for (const c of blogCategories) {
      if (blogCategoryNoindex.has(c.id)) continue;
      entries.push({
        path: `/blog/category/${c.slug}`,
        lastModified: c.updatedAt.toISOString(),
        changeFrequency: 'weekly',
        priority: 0.5,
      });
    }

    // —— 应用场景（仅 PUBLISHED）——
    const applications = await this.prisma.application.findMany({
      where: { status: ContentStatus.PUBLISHED },
      select: { id: true, slug: true, updatedAt: true },
    });
    const appNoindex = await this.noindexIds('APPLICATION', applications.map((a) => a.id));
    for (const a of applications) {
      if (appNoindex.has(a.id)) continue;
      entries.push({
        path: `/applications/${a.slug}`,
        lastModified: a.updatedAt.toISOString(),
        changeFrequency: 'monthly',
        priority: 0.6,
      });
    }

    return entries;
  }

  /** 取某类实体中被显式 noindex 的 ID 集合 */
  private async noindexIds(
    entityType: 'PRODUCT' | 'PRODUCT_CATEGORY' | 'BLOG_POST' | 'BLOG_CATEGORY' | 'APPLICATION',
    ids: string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.seoProfile.findMany({
      where: { entityType, entityId: { in: ids }, robotsIndex: false },
      select: { entityId: true },
    });
    return new Set(rows.map((r) => r.entityId));
  }

  /**
   * robots.txt 文本（任务书二十三节）。
   * Sitemap 域名来自 Global SEO Settings 的 canonicalDomain（未配置时由前台
   * 环境变量兜底），绝不硬编码开发环境域名。
   */
  async getRobotsText(fallbackDomain: string): Promise<string> {
    const settings = await this.settingsService.getSettings();
    const domain = settings.canonicalDomain ?? fallbackDomain;
    const base = domain.replace(/\/+$/, '');
    const lines = [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /api',
      'Disallow: /search',
      'Disallow: /design-system',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ];
    return lines.join('\n');
  }
}
