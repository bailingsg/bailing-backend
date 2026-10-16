import { Injectable, Logger } from '@nestjs/common';
import { ContentStatus, PostStatus, ProductStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SEO_LENGTH_GUIDE, STATIC_PAGES, knownRouteSet } from './seo.constants';
import { SeoAuditIssue, SeoAuditResultDto, SeoAuditSummary } from './entities/seo.entity';
import { computeSeoScore, countH1, countInternalLinks, countWords, scoreToStatus, stripHtml } from './seo-score';

/** 审计收集的实体快照 */
interface AuditEntity {
  entityType: string;
  entityId: string;
  name: string;
  routePath: string;
  isPublished: boolean;
  metaTitle: string;
  metaDescription: string;
  canonicalUrl: string;
  ogImage: string;
  contentBody: string;
  imageCount: number;
  imagesWithAlt: number;
  /** 是否被显式设置 noindex（profile 存在时以 profile 为准） */
  noindex: boolean;
  /** profile 主键（回写评分用；无 profile 为 null） */
  profileId: string | null;
}

/**
 * SEO Audit 引擎（任务书三十~三十三节）
 *
 * 铁律：**只读**。审计不自动修改 / 删除任何内容；修复只能由管理员在
 * Quick Fix 中显式确认（且仅限安全确定项：补 canonical / 默认标题 / 默认描述 / 默认 OG 图）。
 *
 * 检查分级：
 *   critical —— 直接影响收录或抓取（断链、重定向 URL 进 sitemap、404 进 sitemap）
 *   error    —— 缺失关键 SEO 项（标题 / 描述 / Alt / H1）
 *   warning  —— 可改进项（长度不当、noindex 复核、内容偏薄）
 *   passed   —— 通过项（计入总数，用于「Passed 184」统计）
 */
@Injectable()
export class SeoAuditService {
  private readonly logger = new Logger(SeoAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 最近一次审计结果 */
  async getLatest(): Promise<SeoAuditResultDto | null> {
    const run = await this.prisma.seoAuditRun.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!run) return null;
    return {
      id: run.id,
      summary: run.summary as unknown as SeoAuditSummary,
      issues: run.issues as unknown as SeoAuditIssue[],
      durationMs: run.durationMs,
      createdAt: run.createdAt.toISOString(),
    };
  }

  /** 运行全站审计（同步执行；实体规模有限，B2B 站点可接受） */
  async runAudit(actorId: string): Promise<SeoAuditResultDto> {
    const started = Date.now();
    const entities = await this.collectEntities();

    const issues: SeoAuditIssue[] = [];
    let passed = 0;

    const push = (issue: SeoAuditIssue): void => {
      issues.push(issue);
    };

    for (const entity of entities) {
      const base = {
        entityType: entity.entityType,
        entityId: entity.entityId,
        routePath: entity.routePath,
        entityName: entity.name,
      };

      // —— Metadata：标题 ——
      const title = entity.metaTitle.trim();
      if (title === '') {
        push({
          ...base,
          severity: 'error',
          check: 'missing_title',
          title: '缺失 Meta Title',
          message: '未填写 Meta Title（当前由标题模板兜底生成）',
          suggestion: '填写独立 SEO 标题（20–60 字符，含焦点关键词）',
        });
      } else if (title.length < SEO_LENGTH_GUIDE.TITLE_MIN) {
        push({
          ...base,
          severity: 'warning',
          check: 'title_too_short',
          title: 'Meta Title 过短',
          message: `标题 ${title.length} 字符，低于推荐下限 ${SEO_LENGTH_GUIDE.TITLE_MIN}`,
          suggestion: '补充品牌词与价值描述',
        });
      } else if (title.length > SEO_LENGTH_GUIDE.TITLE_MAX) {
        push({
          ...base,
          severity: 'warning',
          check: 'title_too_long',
          title: 'Meta Title 过长',
          message: `标题 ${title.length} 字符，超出推荐上限 ${SEO_LENGTH_GUIDE.TITLE_MAX}（搜索结果显示会被截断）`,
          suggestion: '精简标题，核心词前置',
        });
      } else {
        passed += 1;
      }

      // —— Metadata：描述 ——
      const description = entity.metaDescription.trim();
      if (description === '') {
        push({
          ...base,
          severity: 'error',
          check: 'missing_description',
          title: '缺失 Meta Description',
          message: '未填写 Meta Description',
          suggestion: '撰写 150–160 字符的行动导向描述',
        });
      } else if (description.length < SEO_LENGTH_GUIDE.DESCRIPTION_MIN) {
        push({
          ...base,
          severity: 'warning',
          check: 'description_too_short',
          title: 'Meta Description 过短',
          message: `描述 ${description.length} 字符，低于推荐下限 ${SEO_LENGTH_GUIDE.DESCRIPTION_MIN}`,
          suggestion: '补充卖点与行动号召',
        });
      } else if (description.length > SEO_LENGTH_GUIDE.DESCRIPTION_MAX) {
        push({
          ...base,
          severity: 'warning',
          check: 'description_too_long',
          title: 'Meta Description 过长',
          message: `描述 ${description.length} 字符，超出推荐上限 ${SEO_LENGTH_GUIDE.DESCRIPTION_MAX}`,
          suggestion: '精简到 160 字符以内',
        });
      } else {
        passed += 1;
      }

      // —— Metadata：OG 图 ——
      if (entity.ogImage.trim() === '') {
        push({
          ...base,
          severity: 'warning',
          check: 'missing_og_image',
          title: '缺失 OG Image',
          message: '未设置分享图（社交分享回落站点默认图）',
          suggestion: '设置专属分享图（建议 1200×630）',
        });
      } else {
        passed += 1;
      }

      // —— Technical：Canonical ——
      if (entity.canonicalUrl.trim() === '') {
        push({
          ...base,
          severity: 'warning',
          check: 'missing_canonical',
          title: '未设置 Canonical URL',
          message: '当前自动使用页面标准 URL',
          suggestion: '多入口 / 转载页面建议显式指定',
        });
      } else {
        passed += 1;
      }

      // —— Content：H1 ——
      const h1Count = countH1(entity.contentBody);
      if (h1Count === 0) {
        push({
          ...base,
          severity: 'warning',
          check: 'missing_h1',
          title: '正文缺少 H1',
          message: '页面正文未检测到 H1 标题',
          suggestion: '为正文添加唯一 H1（与页面主题一致）',
        });
      } else if (h1Count > 1) {
        push({
          ...base,
          severity: 'warning',
          check: 'multiple_h1',
          title: '多个 H1',
          message: `正文检测到 ${h1Count} 个 H1`,
          suggestion: '一页只保留一个 H1，其余降级为 H2/H3',
        });
      } else {
        passed += 1;
      }

      // —— Content：内容深度 ——
      const words = countWords(stripHtml(entity.contentBody));
      if (words === 0) {
        push({
          ...base,
          severity: entity.isPublished ? 'error' : 'warning',
          check: 'thin_content',
          title: '内容为空',
          message: '页面没有正文内容',
          suggestion: '补充规格、应用、认证等实质性内容',
        });
      } else if (words < 100) {
        push({
          ...base,
          severity: 'warning',
          check: 'thin_content',
          title: '内容过薄',
          message: `正文约 ${words} 词`,
          suggestion: '建议 300 词以上，覆盖采购商关注点',
        });
      } else {
        passed += 1;
      }

      // —— Content：图片 Alt（图片 SEO 硬性检查项）——
      if (entity.imageCount > 0 && entity.imagesWithAlt < entity.imageCount) {
        push({
          ...base,
          severity: 'error',
          check: 'missing_alt',
          title: '图片缺失 Alt 文本',
          message: `${entity.imageCount - entity.imagesWithAlt}/${entity.imageCount} 张图片没有 Alt`,
          suggestion: '在对应 CMS 中补齐描述性 Alt（SEO → Media SEO）',
        });
      } else if (entity.imageCount > 0) {
        passed += 1;
      }

      // —— Content：内链 ——
      if (countInternalLinks(entity.contentBody) === 0 && entity.entityType !== 'PAGE') {
        push({
          ...base,
          severity: 'warning',
          check: 'missing_internal_links',
          title: '缺少内链',
          message: '正文没有站内链接，也没有配置相关内容',
          suggestion: '在 SEO 编辑器中关联相关产品 / 文章 / 应用场景',
        });
      } else {
        passed += 1;
      }

      // —— URL 规范 ——
      if (entity.routePath !== '/' && /\/{2,}|\/$/.test(entity.routePath.replace(/^https?:\/\//, ''))) {
        push({
          ...base,
          severity: 'error',
          check: 'invalid_url',
          title: 'URL 不规范',
          message: `路径存在双斜杠或结尾斜杠：${entity.routePath}`,
          suggestion: '统一为小写、无结尾斜杠的规范路径',
        });
      } else if (entity.routePath !== entity.routePath.toLowerCase()) {
        push({
          ...base,
          severity: 'warning',
          check: 'invalid_url',
          title: 'URL 含大写',
          message: `路径应全小写：${entity.routePath}`,
          suggestion: 'URL 必须 lowercase',
        });
      } else {
        passed += 1;
      }

      // —— Noindex 复核（sitemap 已自动排除，仅提示管理员确认）——
      if (entity.noindex && entity.isPublished) {
        push({
          ...base,
          severity: 'warning',
          check: 'noindex_review',
          title: '已发布但设置为 Noindex',
          message: '该页面不会进入搜索引擎，且已自动从 sitemap 排除',
          suggestion: '如非测试 / 内部页面，建议改回 Index',
        });
      }
    }

    // —— 跨实体检查：重复 Canonical ——
    const canonicalGroups = new Map<string, AuditEntity[]>();
    for (const entity of entities) {
      const c = entity.canonicalUrl.trim().toLowerCase();
      if (c === '') continue;
      const group = canonicalGroups.get(c) ?? [];
      group.push(entity);
      canonicalGroups.set(c, group);
    }
    for (const [canonical, group] of canonicalGroups) {
      if (group.length > 1) {
        push({
          severity: 'error',
          check: 'duplicate_canonical',
          title: '重复 Canonical',
          entityType: group[0].entityType,
          entityId: group[0].entityId,
          routePath: group[0].routePath,
          entityName: group.map((e) => e.name).join('、'),
          message: `以下页面指向同一 Canonical（${canonical}）：${group.map((e) => e.routePath).join('、')}`,
          suggestion: '每页只应有一个规范地址；修正或移除多余 Canonical',
        });
      }
    }

    // —— 跨实体检查：重复 URL（业务层 slug 唯一已保证，双保险）——
    const routeGroups = new Map<string, AuditEntity[]>();
    for (const entity of entities) {
      const group = routeGroups.get(entity.routePath) ?? [];
      group.push(entity);
      routeGroups.set(entity.routePath, group);
    }
    for (const [route, group] of routeGroups) {
      if (group.length > 1 && route !== '/factory' && route !== '/quality') {
        push({
          severity: 'error',
          check: 'duplicate_url',
          title: '重复 URL',
          entityType: group[0].entityType,
          entityId: group[0].entityId,
          routePath: route,
          entityName: group.map((e) => e.name).join('、'),
          message: `多个实体共用同一前台路径：${route}`,
          suggestion: '检查 slug 唯一性与实体映射',
        });
      }
    }

    // —— Technical：sitemap 中的重定向 URL / 断链 ——
    const [redirects, navItems, sections] = await Promise.all([
      this.prisma.seoRedirect.findMany({ where: { isActive: true } }),
      this.prisma.navItem.findMany({ where: { isActive: true } }),
      this.prisma.siteSection.findMany({
        where: { status: ContentStatus.PUBLISHED, ctaUrl: { not: null } },
      }),
    ]);

    const redirectSources = new Set(redirects.map((r) => r.sourcePath));
    for (const entity of entities) {
      if (redirectSources.has(entity.routePath)) {
        push({
          severity: 'critical',
          check: 'redirect_in_sitemap',
          title: 'Sitemap 包含重定向 URL',
          entityType: entity.entityType,
          entityId: entity.entityId,
          routePath: entity.routePath,
          entityName: entity.name,
          message: `该路径存在生效的重定向规则，却被 sitemap 收录（应收录最终目标）`,
          suggestion: '将重定向目标 URL 加入 sitemap，或停用该规则',
        });
      }
    }

    // —— Technical：站内断链（导航 / 站点分区 CTA）——
    const knownRoutes = knownRouteSet();
    const entityRoutes = new Set(entities.map((e) => e.routePath));
    const linkTargets: { url: string; source: string }[] = [
      ...navItems.map((n) => ({ url: n.url, source: `导航项「${n.label}」` })),
      ...sections.map((s) => ({ url: s.ctaUrl as string, source: `站点分区「${s.sectionKey}」` })),
    ];
    for (const link of linkTargets) {
      const url = link.url.trim();
      if (!url.startsWith('/') || url.startsWith('//')) continue; // 外链不检查
      const clean = url.split('#')[0].split('?')[0].replace(/\/+$/, '') || '/';
      if (clean === '/') continue;
      if (knownRoutes.has(clean) || entityRoutes.has(clean)) continue;
      // 动态前缀（/products/xxx 等）只要前缀已知即放行（实体路由已单独校验）
      const prefix = `/${clean.split('/').filter(Boolean)[0]}`;
      if (knownRoutes.has(prefix)) continue;
      push({
        severity: 'error',
        check: 'broken_internal_link',
        title: '站内断链',
        entityType: null,
        entityId: null,
        routePath: clean,
        entityName: link.source,
        message: `链接指向不存在的站内路径：${clean}`,
        suggestion: '修正链接或补充对应页面',
      });
    }

    const summary: SeoAuditSummary = {
      total: issues.length + passed,
      passed,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      errors: issues.filter((i) => i.severity === 'error').length,
      critical: issues.filter((i) => i.severity === 'critical').length,
    };

    // 落库 + 回写各实体评分快照（seoScore / seoStatus / lastAuditAt）
    const run = await this.prisma.seoAuditRun.create({
      data: {
        summary: summary as unknown as Prisma.InputJsonValue,
        issues: issues as unknown as Prisma.InputJsonValue,
        triggerType: 'MANUAL',
        durationMs: Date.now() - started,
        createdById: actorId,
      },
    });

    await this.writeBackScores(entities);

    this.logger.log(
      `SEO 审计完成：${summary.total} 项检查，passed=${summary.passed} warnings=${summary.warnings} errors=${summary.errors} critical=${summary.critical}`,
    );

    return {
      id: run.id,
      summary,
      issues,
      durationMs: run.durationMs,
      createdAt: run.createdAt.toISOString(),
    };
  }

  /** 汇总全部审计实体（含 profile 与 content 事实） */
  private async collectEntities(): Promise<AuditEntity[]> {    const entities: AuditEntity[] = [];

    const makeBase = (
      entityType: string,
      entityId: string,
      name: string,
      routePath: string,
      isPublished: boolean,
      contentBody: string,
      imageCount: number,
      imagesWithAlt: number,
    ) => ({ entityType, entityId, name, routePath, isPublished, contentBody, imageCount, imagesWithAlt });

    // 静态页面
    for (const page of STATIC_PAGES) {
      entities.push({
        ...makeBase('PAGE', page.key, page.name, page.route, true, '', 0, 0),
        metaTitle: '',
        metaDescription: '',
        canonicalUrl: '',
        ogImage: '',
        noindex: false, profileId: null,
      });
    }

    // 产品
    const products = await this.prisma.product.findMany({
      include: { images: true },
    });
    for (const p of products) {
      entities.push({
        ...makeBase(
          'PRODUCT',
          p.id,
          p.name,
          `/products/${p.slug}`,
          p.status === ProductStatus.PUBLISHED,
          p.description ?? '',
          p.images.length,
          p.images.filter((i) => (i.altText ?? '').trim() !== '').length,
        ),
        metaTitle: p.seoTitle ?? '',
        metaDescription: p.seoDescription ?? '',
        canonicalUrl: '',
        ogImage: '',
        noindex: false, profileId: null,
      });
    }

    // 产品分类
    const categories = await this.prisma.category.findMany();
    for (const c of categories) {
      entities.push({
        ...makeBase('PRODUCT_CATEGORY', c.id, c.name, `/products/category/${c.slug}`, c.isActive, '', 0, 0),
        metaTitle: '',
        metaDescription: c.description ?? '',
        canonicalUrl: '',
        ogImage: '',
        noindex: false, profileId: null,
      });
    }

    // 博客文章
    const posts = await this.prisma.blogPost.findMany({ include: { coverMedia: true } });
    for (const post of posts) {
      entities.push({
        ...makeBase(
          'BLOG_POST',
          post.id,
          post.title,
          `/blog/${post.slug}`,
          post.status === PostStatus.PUBLISHED,
          post.content ?? '',
          post.coverMedia ? 1 : 0,
          post.coverMedia && (post.coverMedia.altText ?? '').trim() !== '' ? 1 : 0,
        ),
        metaTitle: post.seoTitle ?? '',
        metaDescription: post.seoDescription ?? post.excerpt ?? '',
        canonicalUrl: post.canonicalUrl ?? '',
        ogImage: post.ogImage ?? '',
        noindex: false, profileId: null,
      });
    }

    // 博客分类
    const blogCategories = await this.prisma.blogCategory.findMany();
    for (const c of blogCategories) {
      entities.push({
        ...makeBase('BLOG_CATEGORY', c.id, c.name, `/blog/category/${c.slug}`, c.isActive, '', 0, 0),
        metaTitle: '',
        metaDescription: c.description ?? '',
        canonicalUrl: '',
        ogImage: '',
        noindex: false, profileId: null,
      });
    }

    // 应用场景
    const applications = await this.prisma.application.findMany({ include: { coverMedia: true } });
    for (const a of applications) {
      entities.push({
        ...makeBase(
          'APPLICATION',
          a.id,
          a.name,
          `/applications/${a.slug}`,
          a.status === ContentStatus.PUBLISHED,
          a.description ?? '',
          a.coverMedia ? 1 : 0,
          a.coverMedia && (a.coverMedia.altText ?? '').trim() !== '' ? 1 : 0,
        ),
        metaTitle: a.seoTitle ?? '',
        metaDescription: a.seoDescription ?? a.summary ?? '',
        canonicalUrl: '',
        ogImage: '',
        noindex: false, profileId: null,
      });
    }

    // 工厂分区 / 质量记录（共用前台页，实体粒度审计）
    const factorySections = await this.prisma.factorySection.findMany({
      include: { images: true },
    });
    for (const s of factorySections) {
      entities.push({
        ...makeBase(
          'FACTORY_SECTION',
          s.id,
          s.title,
          '/factory',
          s.status === ContentStatus.PUBLISHED,
          s.content ?? '',
          s.images.length,
          s.images.filter((i) => (i.altText ?? '').trim() !== '').length,
        ),
        metaTitle: s.seoTitle ?? '',
        metaDescription: s.seoDescription ?? '',
        canonicalUrl: '',
        ogImage: '',
        noindex: false, profileId: null,
      });
    }

    const qualityRecords = await this.prisma.qualityRecord.findMany({ include: { media: true } });
    for (const r of qualityRecords) {
      entities.push({
        ...makeBase(
          'QUALITY_RECORD',
          r.id,
          r.title,
          '/quality',
          r.status === ContentStatus.PUBLISHED,
          r.description ?? '',
          r.media ? 1 : 0,
          r.media && (r.media.altText ?? '').trim() !== '' ? 1 : 0,
        ),
        metaTitle: r.seoTitle ?? '',
        metaDescription: r.seoDescription ?? '',
        canonicalUrl: '',
        ogImage: '',
        noindex: false, profileId: null,
      });
    }

    // 合并 profile（profile 存在时以其为准）
    const profiles = await this.prisma.seoProfile.findMany();
    const byKey = new Map(profiles.map((p) => [`${p.entityType}:${p.entityId}`, p]));
    for (const entity of entities) {
      const profile = byKey.get(`${entity.entityType}:${entity.entityId}`);
      if (profile) {
        entity.profileId = profile.id;
        entity.noindex = !profile.robotsIndex;
        entity.metaTitle = profile.metaTitle ?? entity.metaTitle;
        entity.metaDescription = profile.metaDescription ?? entity.metaDescription;
        entity.canonicalUrl = profile.canonicalUrl ?? entity.canonicalUrl;
        entity.ogImage = profile.ogImage ?? entity.ogImage;
      }
    }

    return entities;
  }

  /** 审计后回写各实体评分快照（仅更新已存在的 profile，不创建） */
  private async writeBackScores(entities: AuditEntity[]): Promise<void> {
    for (const entity of entities) {
      if (!entity.profileId) continue;
      const { score } = computeSeoScore(
        {
          metaTitle: entity.metaTitle || null,
          metaDescription: entity.metaDescription || null,
          canonicalUrl: entity.canonicalUrl || null,
          robotsIndex: !entity.noindex,
          ogImage: entity.ogImage || null,
          focusKeyword: null,
          schemaType: 'NONE',
          relatedData: null,
        },
        {
          title: entity.name,
          content: entity.contentBody,
          imageCount: entity.imageCount,
          imagesWithAlt: entity.imagesWithAlt,
          hasRoute: true,
          isPublished: entity.isPublished,
        },
      );
      await this.prisma.seoProfile.update({
        where: { id: entity.profileId },
        data: {
          seoScore: score,
          seoStatus: scoreToStatus(score),
          lastAuditAt: new Date(),
        },
      });
    }
  }
}
