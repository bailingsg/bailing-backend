/**
 * SEO 模块常量（Phase 5.0）
 *
 * 静态页面用稳定 key 作 SeoProfile.entityId（如 home / about），
 * 动态实体（产品 / 博客 / 分类…）用业务主键 cuid。
 * 本文件是「前台路由 ↔ SEO 实体」的唯一映射表，
 * 公开解析（/public/seo/resolve）、sitemap 生成、审计都依赖它。
 */

/** 静态页面定义（前台真实存在的非动态路由） */
export interface StaticPageDef {
  /** SeoProfile.entityId 稳定 key */
  key: string;
  /** 前台路径 */
  route: string;
  /** 展示名（英文，面向后台列表） */
  name: string;
  /** 默认标题模板使用的页面标题 */
  defaultTitle: string;
}

export const STATIC_PAGES: readonly StaticPageDef[] = [
  { key: 'home', route: '/', name: 'Home', defaultTitle: 'Bailing Wooden — Professional Wooden Products Manufacturer' },
  { key: 'products', route: '/products', name: 'Products', defaultTitle: 'Products' },
  { key: 'applications', route: '/applications', name: 'Applications', defaultTitle: 'Applications' },
  { key: 'factory', route: '/factory', name: 'Factory', defaultTitle: 'Factory' },
  { key: 'quality', route: '/quality', name: 'Quality', defaultTitle: 'Quality' },
  { key: 'about', route: '/about', name: 'About', defaultTitle: 'About' },
  { key: 'contact', route: '/contact', name: 'Contact', defaultTitle: 'Contact' },
  { key: 'blog', route: '/blog', name: 'Blog', defaultTitle: 'Blog' },
] as const;

export const STATIC_PAGE_KEYS: readonly string[] = STATIC_PAGES.map((p) => p.key);

export function findStaticPageByRoute(route: string): StaticPageDef | undefined {
  return STATIC_PAGES.find((p) => p.route === route);
}

export function findStaticPageByKey(key: string): StaticPageDef | undefined {
  return STATIC_PAGES.find((p) => p.key === key);
}

/** SEO 实体类型 → 展示名（后台） */
export const SEO_ENTITY_TYPE_LABELS: Record<string, string> = {
  PAGE: '静态页面',
  PRODUCT: '产品',
  PRODUCT_CATEGORY: '产品分类',
  BLOG_POST: '博客文章',
  BLOG_CATEGORY: '博客分类',
  APPLICATION: '应用场景',
  FACTORY_SECTION: '工厂分区',
  QUALITY_RECORD: '质量记录',
};

export const SEO_ENTITY_TYPES = [
  'PAGE',
  'PRODUCT',
  'PRODUCT_CATEGORY',
  'BLOG_POST',
  'BLOG_CATEGORY',
  'APPLICATION',
  'FACTORY_SECTION',
  'QUALITY_RECORD',
] as const;

export type SeoEntityTypeValue = (typeof SEO_ENTITY_TYPES)[number];

export function isSeoEntityType(value: string): value is SeoEntityTypeValue {
  return (SEO_ENTITY_TYPES as readonly string[]).includes(value);
}

/** 前台已知路由集合（审计「sitemap 中的 404」与「断链」检查用） */
export function knownRouteSet(): Set<string> {
  const routes = new Set<string>(STATIC_PAGES.map((p) => p.route));
  // 分类路由（保留兼容：路由带参数时为动态实体，由调用方补充实体 slug）
  routes.add('/products/category');
  routes.add('/blog/category');
  return routes;
}

/** Schema.org 类型 → 展示名 */
export const SCHEMA_TYPE_LABELS: Record<string, string> = {
  NONE: '不输出',
  WEB_PAGE: 'WebPage',
  PRODUCT: 'Product',
  ARTICLE: 'Article',
  FAQ_PAGE: 'FAQPage',
};

/** SEO 评分阈值（任务书十二节：评分必须可解释） */
export const SEO_SCORE_THRESHOLDS = {
  GOOD: 90,
  NEEDS_IMPROVEMENT: 50,
} as const;

/** 长度建议（不强制，仅提示） */
export const SEO_LENGTH_GUIDE = {
  TITLE_MIN: 20,
  TITLE_MAX: 60,
  DESCRIPTION_MIN: 120,
  DESCRIPTION_MAX: 160,
} as const;
