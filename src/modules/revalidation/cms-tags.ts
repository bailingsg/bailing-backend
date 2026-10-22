/**
 * CMS 缓存标签（后端侧契约，Phase 4.8）
 *
 * ⚠️ 这些字符串与前台 bailing-ui 的 `src/lib/cms-tags.ts` **逐字对应**，
 * 是前后端之间的缓存失效契约。任何一方修改都必须同步另一方，
 * 否则会出现「后台改了、前台不刷新」的静默故障。
 */

export const CmsTags = {
  products: 'products',
  /** 实体 tag 以产品 id 为键（前台详情路由 /products/[id]） */
  product: (id: string) => `product:${id}`,
  categories: 'categories',

  blog: 'blog',
  blogPost: (slug: string) => `blog:${slug}`,
  blogCategories: 'blog-categories',

  applications: 'applications',
  application: (slug: string) => `application:${slug}`,

  factory: 'factory',
  quality: 'quality',

  site: 'site',
  navigation: 'navigation',
  contacts: 'contacts',

  /**
   * 媒体库（Phase 5.6）。
   * 前台 /factory 等页面按**用途分类**自动聚合媒体库图片，
   * 因此媒体的上传 / 改类 / 删除都必须失效该 tag。
   */
  media: 'media',

  // Phase 5.0：SEO 元数据 / 设置 / 重定向变更后，全站 metadata 需刷新
  seo: 'seo',
} as const;

/** 站点页面前台路径（用于 site 分区变更后的路径级失效） */
export const SITE_PAGE_PATH: Record<string, string> = {
  HOME: '/',
  ABOUT: '/about',
  CONTACT: '/contact',
};

/**
 * 媒体变更（上传 / 删除）后需要失效的全部内容 tag。
 *
 * 媒体被产品 / 博客 / 工厂 / 质量 / 应用 / 站点分区共同引用，
 * 删除一张图可能影响多个页面，因此这里是「全内容」范围的失效。
 */
export const MEDIA_DEPENDENT_TAGS: string[] = [
  CmsTags.products,
  CmsTags.categories,
  CmsTags.blog,
  CmsTags.blogCategories,
  CmsTags.applications,
  CmsTags.factory,
  CmsTags.quality,
  CmsTags.site,
  CmsTags.media,
];

/** 全站页面路径（媒体变更后整站失效，使用 layout 级失效） */
export const ALL_SITE_PATHS: string[] = ['/', '/products', '/blog', '/applications', '/factory', '/quality', '/about', '/contact'];
