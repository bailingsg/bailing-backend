import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentStatus, PostStatus, Prisma, ProductStatus, SeoEntityType, SeoProfile } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidationService } from '../revalidation/revalidation.service';
import { CmsTags } from '../revalidation/cms-tags';
import { UpdateSeoProfileDto } from './dto/seo.dto';
import {
  PaginatedSeoEntities,
  QuickFixResultDto,
  ResolvedSeoDto,
  SeoAuditSummary,
  SeoEntityListItem,
  SeoOverviewDto,
  SeoProfileDto,
} from './entities/seo.entity';
import { computeSeoScore, scoreToStatus, type SeoCheckResult, type SeoProfileSnapshot } from './seo-score';
import {
  findStaticPageByKey,
  findStaticPageByRoute,
  isSeoEntityType,
  SEO_ENTITY_TYPE_LABELS,
  STATIC_PAGES,
} from './seo.constants';
import { SeoSchemaService } from './seo-schema.service';
import { SeoSettingsService } from './seo-settings.service';

/** 实体上下文：聚合业务数据 + SEO 档案 + 评分所需事实 */
interface EntityContext {
  entityType: SeoEntityType;
  entityId: string;
  name: string;
  routePath: string;
  contentTitle: string;
  contentDescription: string;
  contentBody: string;
  imageCount: number;
  imagesWithAlt: number;
  isPublished: boolean;
}

const EMPTY_PROFILE_FIELDS = {
  metaTitle: null,
  metaDescription: null,
  canonicalUrl: null,
  robotsIndex: true,
  robotsFollow: true,
  focusKeyword: null,
  keywords: null,
  ogTitle: null,
  ogDescription: null,
  ogImage: null,
  twitterTitle: null,
  twitterDescription: null,
  twitterImage: null,
  schemaType: 'NONE',
  schemaData: null,
  relatedData: null,
};

function toProfileDto(profile: SeoProfile | null): SeoProfileDto {
  return {
    entityType: profile?.entityType ?? '',
    entityId: profile?.entityId ?? '',
    entityName: profile?.entityName ?? null,
    routePath: profile?.routePath ?? null,
    metaTitle: profile?.metaTitle ?? null,
    metaDescription: profile?.metaDescription ?? null,
    canonicalUrl: profile?.canonicalUrl ?? null,
    robotsIndex: profile?.robotsIndex ?? true,
    robotsFollow: profile?.robotsFollow ?? true,
    focusKeyword: profile?.focusKeyword ?? null,
    keywords: profile?.keywords ?? null,
    ogTitle: profile?.ogTitle ?? null,
    ogDescription: profile?.ogDescription ?? null,
    ogImage: profile?.ogImage ?? null,
    twitterTitle: profile?.twitterTitle ?? null,
    twitterDescription: profile?.twitterDescription ?? null,
    twitterImage: profile?.twitterImage ?? null,
    schemaType: profile?.schemaType ?? 'NONE',
    schemaData: profile?.schemaData ?? null,
    relatedData: profile?.relatedData ?? null,
    seoScore: profile?.seoScore ?? null,
    seoStatus: profile?.seoStatus ?? 'UNAUDITED',
    lastAuditAt: profile?.lastAuditAt?.toISOString() ?? null,
    checks: null,
    updatedAt: profile?.updatedAt.toISOString() ?? new Date().toISOString(),
  };
}

/** 安全 URL 校验：站内相对路径或 https 绝对地址（拒绝 // 与危险协议） */
function assertSafeUrlOrEmpty(value: string | null | undefined, field: string): void {
  if (!value) return;
  if (/^https:\/\//i.test(value)) return;
  if (value.startsWith('/') && !value.startsWith('//')) return;
  throw new BadRequestException(`${field} 必须是站内相对路径（/xxx）或 https 绝对地址`);
}

/** canonical 专项校验：禁止双斜杠、查询串、.hash；域名须与全局设置一致（已配置时） */
function assertCanonical(value: string | null | undefined, canonicalDomain: string | null): void {
  if (!value) return;
  if (/^https:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('canonicalUrl 不是合法 URL');
    }
    if (url.search || url.hash) {
      throw new BadRequestException('canonicalUrl 不允许带查询串或 hash');
    }
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      throw new BadRequestException('canonicalUrl 路径不允许以 / 结尾（双斜杠风险）');
    }
    if (canonicalDomain) {
      const expected = canonicalDomain.replace(/^https:\/\//i, '').toLowerCase();
      if (url.host.toLowerCase() !== expected) {
        throw new BadRequestException(`canonicalUrl 域名必须与全局设置的规范域名一致（${canonicalDomain}）`);
      }
    }
    return;
  }
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (value.includes('?') || value.includes('#')) {
      throw new BadRequestException('canonicalUrl 不允许带查询串或 hash');
    }
    if (value !== '/' && value.endsWith('/')) {
      throw new BadRequestException('canonicalUrl 路径不允许以 / 结尾（双斜杠风险）');
    }
    return;
  }
  throw new BadRequestException('canonicalUrl 必须是站内相对路径或 https 绝对地址');
}

/**
 * 统一 SEO 档案服务（Phase 5.0，任务书十八节「统一 SEO Resolver」的后端侧）
 *
 * 单一数据源：所有可索引实体（静态页面 / 产品 / 分类 / 博客 / 应用 / 工厂 / 质量）
 * 的 SEO 元数据都落在 seo_profiles 表；评分、列表、公开解析、审计全部复用本服务，
 * 不在各业务模块重复实现 SEO 逻辑。
 */
@Injectable()
export class SeoProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schemaService: SeoSchemaService,
    private readonly settingsService: SeoSettingsService,
    private readonly revalidation: RevalidationService,
  ) {}

  /* ------------------------------------------------------------------ */
  /* 实体上下文加载（业务数据 + 评分事实）                                 */
  /* ------------------------------------------------------------------ */

  private async loadContext(entityType: SeoEntityType, entityId: string): Promise<EntityContext> {
    switch (entityType) {
      case 'PAGE': {
        const page = findStaticPageByKey(entityId);
        if (!page) {
          throw new NotFoundException(`未知静态页面 key：${entityId}`);
        }
        // 站点分区标题作为内容标题参考（HOME 分区可能提供 hero 标题）
        const pageEnum = entityId === 'home' ? 'HOME' : entityId === 'about' ? 'ABOUT' : entityId === 'contact' ? 'CONTACT' : null;
        let body = '';
        if (pageEnum) {
          const sections = await this.prisma.siteSection.findMany({
            where: { page: pageEnum as 'HOME' | 'ABOUT' | 'CONTACT', status: ContentStatus.PUBLISHED },
          });
          body = sections.map((s) => [s.title, s.subtitle, s.body].filter(Boolean).join(' ')).join(' ');
        }
        return {
          entityType,
          entityId,
          name: page.name,
          routePath: page.route,
          contentTitle: page.defaultTitle,
          contentDescription: '',
          contentBody: body,
          imageCount: 0,
          imagesWithAlt: 0,
          isPublished: true,
        };
      }
      case 'PRODUCT': {
        const product = await this.prisma.product.findUnique({
          where: { id: entityId },
          include: { images: true },
        });
        if (!product) throw new NotFoundException('产品不存在');
        const withAlt = product.images.filter((img) => (img.altText ?? '').trim() !== '').length;
        return {
          entityType,
          entityId,
          name: product.name,
          routePath: `/products/${product.id}`,
          contentTitle: product.name,
          contentDescription: product.shortDescription ?? '',
          contentBody: product.description ?? '',
          imageCount: product.images.length,
          imagesWithAlt: withAlt,
          isPublished: product.status === ProductStatus.PUBLISHED,
        };
      }
      case 'PRODUCT_CATEGORY': {
        const category = await this.prisma.category.findUnique({ where: { id: entityId } });
        if (!category) throw new NotFoundException('产品分类不存在');
        return {
          entityType,
          entityId,
          name: category.name,
          routePath: `/products/category/${category.slug}`,
          contentTitle: category.name,
          contentDescription: category.description ?? '',
          contentBody: '',
          imageCount: 0,
          imagesWithAlt: 0,
          isPublished: category.isActive,
        };
      }
      case 'BLOG_POST': {
        const post = await this.prisma.blogPost.findUnique({
          where: { id: entityId },
          include: { coverMedia: true },
        });
        if (!post) throw new NotFoundException('博客文章不存在');
        return {
          entityType,
          entityId,
          name: post.title,
          routePath: `/blog/${post.slug}`,
          contentTitle: post.title,
          contentDescription: post.excerpt ?? '',
          contentBody: post.content ?? '',
          imageCount: post.coverMedia ? 1 : 0,
          imagesWithAlt: post.coverMedia && (post.coverMedia.altText ?? '').trim() !== '' ? 1 : 0,
          isPublished: post.status === PostStatus.PUBLISHED,
        };
      }
      case 'BLOG_CATEGORY': {
        const category = await this.prisma.blogCategory.findUnique({ where: { id: entityId } });
        if (!category) throw new NotFoundException('博客分类不存在');
        return {
          entityType,
          entityId,
          name: category.name,
          routePath: `/blog/category/${category.slug}`,
          contentTitle: category.name,
          contentDescription: category.description ?? '',
          contentBody: '',
          imageCount: 0,
          imagesWithAlt: 0,
          isPublished: category.isActive,
        };
      }
      case 'APPLICATION': {
        const app = await this.prisma.application.findUnique({
          where: { id: entityId },
          include: { coverMedia: true },
        });
        if (!app) throw new NotFoundException('应用场景不存在');
        return {
          entityType,
          entityId,
          name: app.name,
          routePath: `/applications/${app.slug}`,
          contentTitle: app.name,
          contentDescription: app.summary ?? '',
          contentBody: app.description ?? '',
          imageCount: app.coverMedia ? 1 : 0,
          imagesWithAlt: app.coverMedia && (app.coverMedia.altText ?? '').trim() !== '' ? 1 : 0,
          isPublished: app.status === ContentStatus.PUBLISHED,
        };
      }
      case 'FACTORY_SECTION': {
        const section = await this.prisma.factorySection.findUnique({
          where: { id: entityId },
          include: { images: { include: { media: true } } },
        });
        if (!section) throw new NotFoundException('工厂分区不存在');
        const imageCount = section.images.length + (section.coverMediaId ? 1 : 0);
        const withAlt = section.images.filter((img) => (img.altText ?? '').trim() !== '').length;
        return {
          entityType,
          entityId,
          name: section.title,
          routePath: `/factory`,
          contentTitle: section.title,
          contentDescription: section.summary ?? '',
          contentBody: section.content ?? '',
          imageCount,
          imagesWithAlt: withAlt,
          isPublished: section.status === ContentStatus.PUBLISHED,
        };
      }
      case 'QUALITY_RECORD': {
        const record = await this.prisma.qualityRecord.findUnique({
          where: { id: entityId },
          include: { media: true },
        });
        if (!record) throw new NotFoundException('质量记录不存在');
        return {
          entityType,
          entityId,
          name: record.title,
          routePath: `/quality`,
          contentTitle: record.title,
          contentDescription: record.description ?? '',
          contentBody: record.description ?? '',
          imageCount: record.media ? 1 : 0,
          imagesWithAlt: record.media && (record.media.altText ?? '').trim() !== '' ? 1 : 0,
          isPublished: record.status === ContentStatus.PUBLISHED,
        };
      }
      default:
        throw new BadRequestException(`不支持的实体类型：${entityType}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 档案读写                                                            */
  /* ------------------------------------------------------------------ */

  /** 读取档案（含实时评分；未创建过时返回默认空档案） */
  async getProfile(entityType: string, entityId: string): Promise<SeoProfileDto> {
    this.assertEntityType(entityType);
    const context = await this.loadContext(entityType as SeoEntityType, entityId);
    const profile = await this.prisma.seoProfile.findUnique({
      where: { entityType_entityId: { entityType: entityType as SeoEntityType, entityId } },
    });
    const dto = toProfileDto(profile);
    dto.entityType = entityType;
    dto.entityId = entityId;
    dto.entityName = profile?.entityName ?? context.name;
    dto.routePath = profile?.routePath ?? context.routePath;
    const score = this.scoreFor(profile, context);
    dto.seoScore = score.score;
    dto.checks = score.checks;
    return dto;
  }

  /** 创建 / 更新档案（部分字段语义：未传不改，传空串清空可空字段） */
  async upsertProfile(
    entityType: string,
    entityId: string,
    dto: UpdateSeoProfileDto,
    actorId: string,
  ): Promise<SeoProfileDto> {
    this.assertEntityType(entityType);
    const context = await this.loadContext(entityType as SeoEntityType, entityId);

    // canonical / og 图安全校验
    const settings = await this.settingsService.getSettings();
    assertCanonical(dto.canonicalUrl, settings.canonicalDomain);
    assertSafeUrlOrEmpty(dto.ogImage, 'ogImage');
    assertSafeUrlOrEmpty(dto.twitterImage, 'twitterImage');

    // schemaData / relatedData 白名单校验（防 XSS / 注入）
    const schemaData = this.schemaService.normalizeSchemaData(dto.schemaData);
    const relatedData = this.schemaService.normalizeRelatedData(dto.relatedData);

    const data: Prisma.SeoProfileUpdateInput = {};
    const assignable = [
      'metaTitle',
      'metaDescription',
      'canonicalUrl',
      'robotsIndex',
      'robotsFollow',
      'focusKeyword',
      'keywords',
      'ogTitle',
      'ogDescription',
      'ogImage',
      'twitterTitle',
      'twitterDescription',
      'twitterImage',
      'schemaType',
    ] as const;
    for (const key of assignable) {
      const value = dto[key as keyof UpdateSeoProfileDto];
      if (value === undefined) continue;
      (data as Record<string, unknown>)[key] = value === '' ? null : value;
    }
    if (dto.schemaData !== undefined) data.schemaData = schemaData as unknown as Prisma.InputJsonValue;
    if (dto.relatedData !== undefined) data.relatedData = relatedData as unknown as Prisma.InputJsonValue;

    const profile = await this.prisma.seoProfile.upsert({
      where: { entityType_entityId: { entityType: entityType as SeoEntityType, entityId } },
      create: {
        ...(data as Prisma.SeoProfileCreateInput),
        entityType: entityType as SeoEntityType,
        entityId,
        entityName: context.name,
        routePath: context.routePath,
        updatedById: actorId,
      },
      update: {
        ...data,
        entityName: context.name,
        routePath: context.routePath,
        updatedById: actorId,
      },
    });

    await this.invalidateSeo(context.routePath);
    return this.getProfile(entityType, entityId);
  }

  /* ------------------------------------------------------------------ */
  /* 评分（列表 / 详情 / 审计共用）                                        */
  /* ------------------------------------------------------------------ */

  private scoreFor(profile: SeoProfile | null, context: EntityContext) {
    const snapshot: SeoProfileSnapshot = profile
      ? {
          metaTitle: profile.metaTitle,
          metaDescription: profile.metaDescription,
          canonicalUrl: profile.canonicalUrl,
          robotsIndex: profile.robotsIndex,
          ogImage: profile.ogImage,
          focusKeyword: profile.focusKeyword,
          schemaType: profile.schemaType,
          relatedData: profile.relatedData,
        }
      : { ...EMPTY_PROFILE_FIELDS };
    return computeSeoScore(snapshot, {
      title: context.contentTitle,
      content: context.contentBody,
      imageCount: context.imageCount,
      imagesWithAlt: context.imagesWithAlt,
      hasRoute: true,
      isPublished: context.isPublished,
    });
  }

  /** SEO 变更后的前台失效（seo tag + 实体路径） */
  private async invalidateSeo(routePath: string): Promise<void> {
    await this.revalidation.invalidate({
      tags: [CmsTags.seo],
      paths: [routePath, '/sitemap.xml', '/robots.txt'],
    });
  }

  private assertEntityType(value: string): void {
    if (!isSeoEntityType(value)) {
      throw new BadRequestException(`不支持的 SEO 实体类型：${value}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 后台列表（Pages / Products / Blog / 全量）                            */
  /* ------------------------------------------------------------------ */

  /**
   * 聚合列表：业务实体 + SEO 档案 + 实时评分。
   * entityType 为空时返回全部实体（Overview 的「最近更新」视图）。
   */
  async listEntities(
    entityType: string | undefined,
    query: { page?: number; limit?: number; keyword?: string; status?: string; issuesOnly?: boolean },
  ): Promise<PaginatedSeoEntities> {
    if (entityType !== undefined) this.assertEntityType(entityType);

    const rows = await this.collectRows(entityType as SeoEntityType | undefined);
    const keyword = (query.keyword ?? '').trim().toLowerCase();

    let items: SeoEntityListItem[] = [];
    for (const row of rows) {
      if (keyword) {
        const haystack = `${row.name} ${row.url} ${row.metaTitle ?? ''}`.toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }
      if (query.status && row.seoStatus !== query.status) continue;
      if (query.issuesOnly && row.seoScore !== null && row.seoScore >= 90) continue;
      items.push(row);
    }

    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const total = items.length;
    const paged = items.slice((page - 1) * limit, page * limit);

    return { items: paged, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** 汇总所有实体行（评分在加载时实时计算） */
  private async collectRows(entityType?: SeoEntityType): Promise<SeoEntityListItem[]> {
    const types: SeoEntityType[] = entityType
      ? [entityType]
      : (['PAGE', 'PRODUCT', 'PRODUCT_CATEGORY', 'BLOG_POST', 'BLOG_CATEGORY', 'APPLICATION', 'FACTORY_SECTION', 'QUALITY_RECORD'] as SeoEntityType[]);

    const rows: SeoEntityListItem[] = [];

    if (types.includes('PAGE')) {
      for (const page of STATIC_PAGES) {
        rows.push(await this.buildRow('PAGE', page.key, page.name, page.route, page.defaultTitle, 'PUBLISHED', new Date()));
      }
    }

    if (types.includes('PRODUCT')) {
      const products = await this.prisma.product.findMany({
        include: { images: true },
        orderBy: { updatedAt: 'desc' },
      });
      for (const p of products) {
        const row = await this.buildRow('PRODUCT', p.id, p.name, `/products/${p.id}`, p.name, p.status, p.updatedAt);
        row.metaDescription = p.seoDescription ?? null;
        rows.push(row);
      }
    }

    if (types.includes('PRODUCT_CATEGORY')) {
      const categories = await this.prisma.category.findMany({ orderBy: { updatedAt: 'desc' } });
      for (const c of categories) {
        rows.push(await this.buildRow('PRODUCT_CATEGORY', c.id, c.name, `/products/category/${c.slug}`, c.name, c.isActive ? 'PUBLISHED' : 'DRAFT', c.updatedAt));
      }
    }

    if (types.includes('BLOG_POST')) {
      const posts = await this.prisma.blogPost.findMany({
        include: { coverMedia: true },
        orderBy: { updatedAt: 'desc' },
      });
      for (const post of posts) {
        const row = await this.buildRow('BLOG_POST', post.id, post.title, `/blog/${post.slug}`, post.title, post.status, post.updatedAt);
        row.metaDescription = post.seoDescription ?? null;
        rows.push(row);
      }
    }

    if (types.includes('BLOG_CATEGORY')) {
      const categories = await this.prisma.blogCategory.findMany({ orderBy: { updatedAt: 'desc' } });
      for (const c of categories) {
        rows.push(await this.buildRow('BLOG_CATEGORY', c.id, c.name, `/blog/category/${c.slug}`, c.name, c.isActive ? 'PUBLISHED' : 'DRAFT', c.updatedAt));
      }
    }

    if (types.includes('APPLICATION')) {
      const apps = await this.prisma.application.findMany({
        include: { coverMedia: true },
        orderBy: { updatedAt: 'desc' },
      });
      for (const app of apps) {
        const row = await this.buildRow('APPLICATION', app.id, app.name, `/applications/${app.slug}`, app.name, app.status, app.updatedAt);
        row.metaDescription = app.seoDescription ?? null;
        rows.push(row);
      }
    }

    if (types.includes('FACTORY_SECTION')) {
      const sections = await this.prisma.factorySection.findMany({
        include: { images: true },
        orderBy: { updatedAt: 'desc' },
      });
      for (const s of sections) {
        const row = await this.buildRow('FACTORY_SECTION', s.id, s.title, '/factory', s.title, s.status, s.updatedAt);
        row.metaDescription = s.seoDescription ?? null;
        rows.push(row);
      }
    }

    if (types.includes('QUALITY_RECORD')) {
      const records = await this.prisma.qualityRecord.findMany({ orderBy: { updatedAt: 'desc' } });
      for (const r of records) {
        const row = await this.buildRow('QUALITY_RECORD', r.id, r.title, '/quality', r.title, r.status, r.updatedAt);
        row.metaDescription = r.seoDescription ?? null;
        rows.push(row);
      }
    }

    return rows;
  }

  /** 构造单行（档案 + 评分 + legacy 字段回退） */
  private async buildRow(
    entityType: SeoEntityType,
    entityId: string,
    name: string,
    routePath: string,
    contentTitle: string,
    businessStatus: string,
    updatedAt: Date,
  ): Promise<SeoEntityListItem> {
    const profile = await this.prisma.seoProfile.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
    });
    const context = await this.loadContext(entityType, entityId);
    const { score } = this.scoreFor(profile, context);

    // legacy 字段回退（迁移兼容）：Product.seoTitle 等旧字段仍生效
    const legacyTitle = entityType === 'PRODUCT' ? await this.legacyTitle('PRODUCT', entityId) : entityType === 'BLOG_POST' ? await this.legacyTitle('BLOG_POST', entityId) : null;

    const effectiveTitle = profile?.metaTitle ?? legacyTitle ?? contentTitle;
    const canonical = profile?.canonicalUrl ?? null;

    // 实时状态档位（与分数同源；审计运行后库中 seoStatus 与之保持一致）
    const status = scoreToStatus(score);

    return {
      entityType,
      entityId,
      name,
      url: routePath,
      effectiveTitle,
      metaTitle: profile?.metaTitle ?? null,
      metaDescription: profile?.metaDescription ?? null,
      canonical,
      ogImage: profile?.ogImage ?? null,
      schemaType: profile?.schemaType ?? 'NONE',
      robotsIndex: profile?.robotsIndex ?? true,
      robotsFollow: profile?.robotsFollow ?? true,
      seoScore: score,
      seoStatus: status,
      businessStatus,
      updatedAt: updatedAt.toISOString(),
    };
  }

  /** legacy SEO 字段回退（迁移兼容，只读） */
  private async legacyTitle(entityType: 'PRODUCT' | 'BLOG_POST', entityId: string): Promise<string | null> {
    if (entityType === 'PRODUCT') {
      const p = await this.prisma.product.findUnique({ where: { id: entityId }, select: { seoTitle: true } });
      return p?.seoTitle ?? null;
    }
    const post = await this.prisma.blogPost.findUnique({ where: { id: entityId }, select: { seoTitle: true } });
    return post?.seoTitle ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* 公开解析（前台统一 SEO Resolver 的数据源）                              */
  /* ------------------------------------------------------------------ */

  /**
   * 按前台路径批量解析 SEO 档案。
   * 路径 → 实体映射（与前台路由逐字对应）：
   *   /                       → PAGE:home
   *   /products               → PAGE:products
   *   /products/{id}          → PRODUCT（旧 slug 路径兼容）
   *   /products/category/{slug} → PRODUCT_CATEGORY
   *   /blog                   → PAGE:blog
   *   /blog/{slug}            → BLOG_POST
   *   /blog/category/{slug}   → BLOG_CATEGORY
   *   /applications[/{slug}]  → PAGE:applications / APPLICATION
   *   /factory /quality /about /contact → PAGE:*
   * 未匹配到实体（不存在 / 未发布 / 已删除）→ profile 为 null（前台走默认逻辑）。
   */
  async resolveByPaths(paths: string[]): Promise<ResolvedSeoDto[]> {
    const unique = Array.from(new Set(paths.filter((p) => typeof p === 'string' && p.startsWith('/')))).slice(0, 20);
    const results: ResolvedSeoDto[] = [];

    for (const path of unique) {
      const resolved = await this.resolveOnePath(path);
      results.push(resolved);
    }
    return results;
  }

  private async resolveOnePath(path: string): Promise<ResolvedSeoDto> {
    const clean = path.replace(/\/+$/, '') || '/';

    // 静态页面精确匹配
    const staticPage = findStaticPageByRoute(clean);
    if (staticPage) {
      const profile = await this.prisma.seoProfile.findUnique({
        where: { entityType_entityId: { entityType: 'PAGE', entityId: staticPage.key } },
      });
      return { path, profile: profile ? toPublicProjection(profile) : null };
    }

    const segments = clean.split('/').filter(Boolean);

    // /products/{id}（前台详情路由以 id 拼接；旧 slug 路径仍兼容）
    if (segments[0] === 'products' && segments.length === 2) {
      const ref = segments[1];
      const product =
        (await this.prisma.product.findUnique({
          where: { id: ref },
          select: { id: true, status: true },
        })) ??
        (await this.prisma.product.findUnique({
          where: { slug: ref },
          select: { id: true, status: true },
        }));
      if (product && product.status === ProductStatus.PUBLISHED) {
        const profile = await this.prisma.seoProfile.findUnique({
          where: { entityType_entityId: { entityType: 'PRODUCT', entityId: product.id } },
        });
        return { path, profile: profile ? toPublicProjection(profile) : null };
      }
    }

    // /products/category/{slug}
    if (segments[0] === 'products' && segments[1] === 'category' && segments.length === 3) {
      const category = await this.prisma.category.findUnique({
        where: { slug: segments[2] },
        select: { id: true, isActive: true },
      });
      if (category && category.isActive) {
        const profile = await this.prisma.seoProfile.findUnique({
          where: { entityType_entityId: { entityType: 'PRODUCT_CATEGORY', entityId: category.id } },
        });
        return { path, profile: profile ? toPublicProjection(profile) : null };
      }
    }

    // /blog/{slug}
    if (segments[0] === 'blog' && segments.length === 2) {
      const post = await this.prisma.blogPost.findUnique({
        where: { slug: segments[1] },
        select: { id: true, status: true },
      });
      if (post && post.status === PostStatus.PUBLISHED) {
        const profile = await this.prisma.seoProfile.findUnique({
          where: { entityType_entityId: { entityType: 'BLOG_POST', entityId: post.id } },
        });
        return { path, profile: profile ? toPublicProjection(profile) : null };
      }
    }

    // /blog/category/{slug}
    if (segments[0] === 'blog' && segments[1] === 'category' && segments.length === 3) {
      const category = await this.prisma.blogCategory.findUnique({
        where: { slug: segments[2] },
        select: { id: true, isActive: true },
      });
      if (category && category.isActive) {
        const profile = await this.prisma.seoProfile.findUnique({
          where: { entityType_entityId: { entityType: 'BLOG_CATEGORY', entityId: category.id } },
        });
        return { path, profile: profile ? toPublicProjection(profile) : null };
      }
    }

    // /applications/{slug}
    if (segments[0] === 'applications' && segments.length === 2) {
      const app = await this.prisma.application.findUnique({
        where: { slug: segments[1] },
        select: { id: true, status: true },
      });
      if (app && app.status === ContentStatus.PUBLISHED) {
        const profile = await this.prisma.seoProfile.findUnique({
          where: { entityType_entityId: { entityType: 'APPLICATION', entityId: app.id } },
        });
        return { path, profile: profile ? toPublicProjection(profile) : null };
      }
    }

    return { path, profile: null };
  }

  /* ------------------------------------------------------------------ */
  /* 快捷修复（仅填补空缺，不覆盖已有值；返回 before/after diff）             */
  /* ------------------------------------------------------------------ */

  async quickFix(
    entityType: string,
    entityId: string,
    fields: string[],
    actorId: string,
    dryRun = false,
  ): Promise<QuickFixResultDto> {
    this.assertEntityType(entityType);
    const context = await this.loadContext(entityType as SeoEntityType, entityId);
    const profile = await this.prisma.seoProfile.findUnique({
      where: { entityType_entityId: { entityType: entityType as SeoEntityType, entityId } },
    });
    const settings = await this.settingsService.getSettings();

    const applied: QuickFixResultDto['applied'] = [];
    const skipped: QuickFixResultDto['skipped'] = [];
    const patch: Prisma.SeoProfileUpdateInput = {};

    for (const field of fields) {
      const current = (profile as Record<string, unknown> | null)?.[field] as string | null | undefined;
      const currentValue = typeof current === 'string' && current.trim() !== '' ? current : null;
      if (currentValue) {
        skipped.push({ field, reason: '已有值，不覆盖' });
        continue;
      }

      if (field === 'canonicalUrl') {
        const domain = (settings.canonicalDomain ?? '').replace(/\/+$/, '');
        const value = domain ? `${domain}${context.routePath}` : context.routePath;
        patch.canonicalUrl = value;
        applied.push({ field, before: null, after: value });
      } else if (field === 'metaTitle') {
        const template =
          entityType === 'PRODUCT' || entityType === 'PRODUCT_CATEGORY'
            ? settings.productTitleTemplate
            : entityType === 'BLOG_POST' || entityType === 'BLOG_CATEGORY'
              ? settings.blogTitleTemplate
              : settings.pageTitleTemplate;
        const value = template.replace('%title%', context.contentTitle).slice(0, 200);
        patch.metaTitle = value;
        applied.push({ field, before: null, after: value });
      } else if (field === 'metaDescription') {
        const base = context.contentDescription.trim() || context.contentBody.trim();
        const plain = base.replace(/\s+/g, ' ').slice(0, 157).trim();
        if (plain === '') {
          skipped.push({ field, reason: '没有可用的内容文本生成描述' });
          continue;
        }
        const value = plain.endsWith('.') ? plain : `${plain}…`;
        patch.metaDescription = value;
        applied.push({ field, before: null, after: value });
      } else if (field === 'ogImage') {
        if (!settings.defaultOgImage) {
          skipped.push({ field, reason: '全局设置未配置默认 OG 图' });
          continue;
        }
        patch.ogImage = settings.defaultOgImage;
        applied.push({ field, before: null, after: settings.defaultOgImage });
      } else {
        skipped.push({ field, reason: '不支持的字段' });
      }
    }

    if (applied.length > 0 && !dryRun) {
      await this.prisma.seoProfile.upsert({
        where: { entityType_entityId: { entityType: entityType as SeoEntityType, entityId } },
        create: {
          ...(patch as Prisma.SeoProfileCreateInput),
          entityType: entityType as SeoEntityType,
          entityId,
          entityName: context.name,
          routePath: context.routePath,
          updatedById: actorId,
        },
        update: { ...patch, updatedById: actorId },
      });
      await this.invalidateSeo(context.routePath);
    }

    return { applied, skipped };
  }

  /* ------------------------------------------------------------------ */
  /* Overview Dashboard                                                  */
  /* ------------------------------------------------------------------ */

  async getOverview(): Promise<SeoOverviewDto> {
    const rows = await this.collectRows();

    const missingMetaTitle = rows.filter((r) => (r.metaTitle ?? '').trim() === '').length;
    const missingMetaDescription = rows.filter((r) => (r.metaDescription ?? '').trim() === '').length;
    const missingCanonical = rows.filter((r) => (r.canonical ?? '').trim() === '').length;
    const missingOgImage = rows.filter((r) => (r.ogImage ?? '').trim() === '').length;
    const noindexEntities = rows.filter((r) => !r.robotsIndex).length;

    const [imageStats, latestRun] = await Promise.all([
      this.prisma.mediaAsset.groupBy({
        by: ['category'],
        where: { category: 'IMAGE' },
        _count: { _all: true },
      }),
      this.prisma.seoAuditRun.findFirst({ orderBy: { createdAt: 'desc' } }),
    ]);

    const totalImages = imageStats.reduce((sum, g) => sum + g._count._all, 0);
    const missingAltImages = await this.prisma.mediaAsset.count({
      where: { category: 'IMAGE', OR: [{ altText: null }, { altText: '' }] },
    });

    // 按类型汇总（含缺失标题数）
    const byTypeMap = new Map<string, { total: number; missingTitle: number }>();
    for (const row of rows) {
      const entry = byTypeMap.get(row.entityType) ?? { total: 0, missingTitle: 0 };
      entry.total += 1;
      if ((row.metaTitle ?? '').trim() === '') entry.missingTitle += 1;
      byTypeMap.set(row.entityType, entry);
    }
    const byType = Array.from(byTypeMap.entries()).map(([entityType, v]) => ({
      entityType,
      label: SEO_ENTITY_TYPE_LABELS[entityType] ?? entityType,
      total: v.total,
      missingTitle: v.missingTitle,
    }));

    return {
      totalEntities: rows.length,
      indexedEntities: rows.length - noindexEntities,
      noindexEntities,
      missingMetaTitle,
      missingMetaDescription,
      missingCanonical,
      missingOgImage,
      missingAltImages,
      totalImages,
      scoreDistribution: {
        good: rows.filter((r) => r.seoScore !== null && r.seoScore >= 90).length,
        needsImprovement: rows.filter((r) => r.seoScore !== null && r.seoScore >= 50 && r.seoScore < 90).length,
        poor: rows.filter((r) => r.seoScore !== null && r.seoScore < 50).length,
        unaudited: rows.filter((r) => r.seoScore === null).length,
      },
      byType,
      latestAudit: latestRun
        ? {
            id: latestRun.id,
            summary: latestRun.summary as unknown as SeoAuditSummary,
            createdAt: latestRun.createdAt.toISOString(),
          }
        : null,
    };
  }
}

/** 档案 → 公开投影（白名单字段；绝不出透 storageKey / createdBy 等内部字段） */
function toPublicProjection(profile: SeoProfile): ResolvedSeoDto['profile'] {
  return {
    metaTitle: profile.metaTitle,
    metaDescription: profile.metaDescription,
    canonicalUrl: profile.canonicalUrl,
    robotsIndex: profile.robotsIndex,
    robotsFollow: profile.robotsFollow,
    ogTitle: profile.ogTitle,
    ogDescription: profile.ogDescription,
    ogImage: profile.ogImage,
    twitterTitle: profile.twitterTitle,
    twitterDescription: profile.twitterDescription,
    twitterImage: profile.twitterImage,
    schemaType: profile.schemaType,
    schemaData: profile.schemaData,
    relatedData: profile.relatedData,
  };
}
