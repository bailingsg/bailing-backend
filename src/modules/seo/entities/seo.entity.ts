/** SEO 模块响应实体（Phase 5.0） */

export interface SeoProfileDto {
  entityType: string;
  entityId: string;
  entityName: string | null;
  routePath: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsIndex: boolean;
  robotsFollow: boolean;
  focusKeyword: string | null;
  keywords: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  schemaType: string;
  schemaData: unknown;
  relatedData: unknown;
  seoScore: number | null;
  seoStatus: string;
  lastAuditAt: string | null;
  /** 评分明细（可解释性：为什么是这个分数；仅档案详情接口返回） */
  checks: SeoCheckResult[] | null;
  updatedAt: string;
}

/** 单项评分检查（与后端 seo-score.ts 一致，前端原样渲染） */
export interface SeoCheckResult {
  key: string;
  label: string;
  severity: 'error' | 'warning' | 'passed';
  weight: number;
  earned: number;
  message: string;
  suggestion?: string;
}

/** 后台列表统一行（pages / products / blog 共用结构） */
export interface SeoEntityListItem {  entityType: string;
  entityId: string;
  /** 展示名（产品名 / 文章标题 / 页面名） */
  name: string;
  /** 前台 URL */
  url: string;
  /** 生效的 SEO 标题（手填 > 内容 > 模板预览） */
  effectiveTitle: string;
  metaTitle: string | null;
  metaDescription: string | null;
  canonical: string | null;
  ogImage: string | null;
  schemaType: string;
  robotsIndex: boolean;
  robotsFollow: boolean;
  seoScore: number | null;
  seoStatus: string;
  /** 业务状态（PUBLISHED / DRAFT / …；静态页固定 PUBLISHED） */
  businessStatus: string;
  updatedAt: string;
}

export interface PaginatedSeoEntities {
  items: SeoEntityListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Overview Dashboard 汇总 */
export interface SeoOverviewDto {
  totalEntities: number;
  indexedEntities: number;
  noindexEntities: number;
  missingMetaTitle: number;
  missingMetaDescription: number;
  missingCanonical: number;
  missingOgImage: number;
  missingAltImages: number;
  totalImages: number;
  scoreDistribution: { good: number; needsImprovement: number; poor: number; unaudited: number };
  byType: { entityType: string; label: string; total: number; missingTitle: number }[];
  latestAudit: {
    id: string;
    summary: SeoAuditSummary;
    createdAt: string;
  } | null;
}

export interface SeoAuditSummary {
  total: number;
  passed: number;
  warnings: number;
  errors: number;
  critical: number;
}

export type SeoAuditSeverity = 'critical' | 'error' | 'warning' | 'passed';

export interface SeoAuditIssue {
  severity: SeoAuditSeverity;
  /** 检查项，如 missing_title / duplicate_canonical */
  check: string;
  /** 中文标题，如「缺失 Meta Title」 */
  title: string;
  entityType: string | null;
  entityId: string | null;
  routePath: string | null;
  entityName: string | null;
  message: string;
  suggestion: string;
}

export interface SeoAuditResultDto {
  id: string;
  summary: SeoAuditSummary;
  issues: SeoAuditIssue[];
  durationMs: number;
  createdAt: string;
}

export interface SeoRedirectDto {
  id: string;
  sourcePath: string;
  targetPath: string;
  statusCode: number;
  isActive: boolean;
  note: string | null;
  hits: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedSeoRedirects {
  items: SeoRedirectDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Sitemap 条目（后台预览与前台 sitemap.xml 共用） */
export interface SeoSitemapEntry {
  path: string;
  lastModified: string;
  changeFrequency: string;
  priority: number;
}

/** 公开解析：单个路径的生效 SEO 元数据 */
export interface ResolvedSeoDto {
  path: string;
  profile: {
    metaTitle: string | null;
    metaDescription: string | null;
    canonicalUrl: string | null;
    robotsIndex: boolean;
    robotsFollow: boolean;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
    twitterTitle: string | null;
    twitterDescription: string | null;
    twitterImage: string | null;
    schemaType: string;
    schemaData: unknown;
    relatedData: unknown;
  } | null;
}

/** 快捷修复的字段级 diff */
export interface QuickFixFieldDiff {
  field: string;
  before: string | null;
  after: string;
}

export interface QuickFixResultDto {
  applied: QuickFixFieldDiff[];
  skipped: { field: string; reason: string }[];
}
