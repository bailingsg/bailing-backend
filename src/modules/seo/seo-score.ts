import { SEO_LENGTH_GUIDE, SEO_SCORE_THRESHOLDS } from './seo.constants';

/**
 * SEO 评分引擎（Phase 5.0，任务书十二节）
 *
 * 硬性要求：**评分必须可解释**——后台能看到「为什么这个页面只有 65 分」。
 * 因此评分 = 一组固定检查项的加权通过率，每项检查都带：
 *   · severity：error（缺失关键项）/ warning（可改进）/ passed
 *   · weight：该项满分值；earned：实得分
 *   · message + suggestion：通过说明 / 问题描述与修复建议
 *
 * 同一套检查同时服务三处：列表页评分、详情页评分、SEO Audit 引擎。
 * 算法公开、无黑箱；调整权重只需改本文件的 CHECKS。
 */

export type SeoCheckSeverity = 'error' | 'warning' | 'passed';

export interface SeoCheckResult {
  key: string;
  label: string;
  severity: SeoCheckSeverity;
  weight: number;
  earned: number;
  message: string;
  suggestion?: string;
}

/** 参与评分的 SEO 档案字段（快照） */
export interface SeoProfileSnapshot {
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsIndex: boolean;
  ogImage: string | null;
  focusKeyword: string | null;
  schemaType: string;
  relatedData: unknown;
}

/** 参与评分的内容事实（来自业务实体） */
export interface SeoContentInput {
  /** 内容主标题（产品名 / 文章标题 / 页面标题） */
  title: string;
  /** 正文（HTML 或纯文本）：用于 H1 与字数评估 */
  content?: string | null;
  /** 图片总数 */
  imageCount: number;
  /** 带 alt 的图片数 */
  imagesWithAlt: number;
  /** 是否有路由（可导出 canonical） */
  hasRoute: boolean;
  /** 是否已发布（草稿只提示不重罚） */
  isPublished: boolean;
}

export interface SeoScoreResult {
  score: number;
  checks: SeoCheckResult[];
  errorCount: number;
  warningCount: number;
  passedCount: number;
}

/** 去掉 HTML 标签取正文文本 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统计英文单词数（以空白切分） */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/** 统计 HTML 中 <h1> 出现次数（容忍属性与大小写） */
export function countH1(html: string): number {
  const matches = html.match(/<h1[\s>]/gi);
  return matches ? matches.length : 0;
}

/** 统计正文中的内链数量（站内相对链接） */
export function countInternalLinks(html: string): number {
  const matches = html.match(/href=["'](\/[^"']*)["']/gi);
  return matches ? matches.length : 0;
}

const WEIGHTS = {
  metaTitle: 15,
  titleLength: 5,
  metaDescription: 15,
  descriptionLength: 5,
  canonical: 10,
  ogImage: 10,
  robotsIndex: 5,
  focusKeyword: 10,
  schemaType: 5,
  altCoverage: 10,
  contentDepth: 5,
  internalLinks: 5,
} as const;

/**
 * 计算单个实体的 SEO 评分与检查明细。
 */
export function computeSeoScore(
  profile: SeoProfileSnapshot | null,
  content: SeoContentInput,
): SeoScoreResult {
  const checks: SeoCheckResult[] = [];
  const p = profile;

  const title = p?.metaTitle?.trim() ?? '';
  const description = p?.metaDescription?.trim() ?? '';
  const words = countWords(stripHtml(content.content ?? ''));

  // 1. Meta Title 存在（缺失会由模板兜底生成，但仍是 error 级问题）
  checks.push({
    key: 'metaTitle',
    label: 'Meta Title',
    severity: title !== '' ? 'passed' : 'error',
    weight: WEIGHTS.metaTitle,
    earned: title !== '' ? WEIGHTS.metaTitle : 0,
    message: title !== '' ? 'Meta Title 已填写' : '未填写 Meta Title（当前由标题模板兜底）',
    suggestion: title === '' ? '填写独立的 SEO 标题（建议 20–60 字符，含焦点关键词）' : undefined,
  });

  // 2. Meta Title 长度
  const titleOk = title.length >= SEO_LENGTH_GUIDE.TITLE_MIN && title.length <= SEO_LENGTH_GUIDE.TITLE_MAX;
  checks.push({
    key: 'titleLength',
    label: 'Meta Title 长度',
    severity: titleOk ? 'passed' : 'warning',
    weight: WEIGHTS.titleLength,
    earned: titleOk ? WEIGHTS.titleLength : 0,
    message: titleOk
      ? `标题长度 ${title.length} 字符（推荐 ${SEO_LENGTH_GUIDE.TITLE_MIN}–${SEO_LENGTH_GUIDE.TITLE_MAX}）`
      : `标题长度 ${title.length} 字符，超出推荐区间 ${SEO_LENGTH_GUIDE.TITLE_MIN}–${SEO_LENGTH_GUIDE.TITLE_MAX}`,
    suggestion: titleOk ? undefined : '调整标题长度，避免搜索结果中被截断',
  });

  // 3. Meta Description 存在
  checks.push({
    key: 'metaDescription',
    label: 'Meta Description',
    severity: description !== '' ? 'passed' : 'error',
    weight: WEIGHTS.metaDescription,
    earned: description !== '' ? WEIGHTS.metaDescription : 0,
    message: description !== '' ? 'Meta Description 已填写' : '未填写 Meta Description（可能被搜索引擎自动摘录）',
    suggestion: description === '' ? '撰写 150–160 字符的行动导向描述' : undefined,
  });

  // 4. Meta Description 长度
  const descOk =
    description.length >= SEO_LENGTH_GUIDE.DESCRIPTION_MIN &&
    description.length <= SEO_LENGTH_GUIDE.DESCRIPTION_MAX;
  checks.push({
    key: 'descriptionLength',
    label: 'Meta Description 长度',
    severity: descOk ? 'passed' : 'warning',
    weight: WEIGHTS.descriptionLength,
    earned: descOk ? WEIGHTS.descriptionLength : 0,
    message: descOk
      ? `描述长度 ${description.length} 字符（推荐 ${SEO_LENGTH_GUIDE.DESCRIPTION_MIN}–${SEO_LENGTH_GUIDE.DESCRIPTION_MAX}）`
      : `描述长度 ${description.length} 字符，超出推荐区间 ${SEO_LENGTH_GUIDE.DESCRIPTION_MIN}–${SEO_LENGTH_GUIDE.DESCRIPTION_MAX}`,
    suggestion: descOk ? undefined : '描述过短信息不足、过长会被截断',
  });

  // 5. Canonical（未手填可由路由自动导出，给一半分并提示）
  const canonicalSet = (p?.canonicalUrl ?? '').trim() !== '';
  checks.push({
    key: 'canonical',
    label: 'Canonical URL',
    severity: canonicalSet ? 'passed' : 'warning',
    weight: WEIGHTS.canonical,
    earned: canonicalSet ? WEIGHTS.canonical : content.hasRoute ? WEIGHTS.canonical / 2 : 0,
    message: canonicalSet
      ? '已设置 Canonical URL'
      : content.hasRoute
        ? '未手填 Canonical（当前自动使用页面标准 URL）'
        : '未设置 Canonical URL 且无法自动导出',
    suggestion: canonicalSet ? undefined : '跨站转载 / 多入口页面建议显式指定 Canonical',
  });

  // 6. OG Image
  const ogSet = (p?.ogImage ?? '').trim() !== '';
  checks.push({
    key: 'ogImage',
    label: 'OG Image',
    severity: ogSet ? 'passed' : 'error',
    weight: WEIGHTS.ogImage,
    earned: ogSet ? WEIGHTS.ogImage : 0,
    message: ogSet ? '已设置分享图' : '未设置 OG 图片（社交分享将使用站点默认图）',
    suggestion: ogSet ? undefined : '为页面设置专属分享图（建议 1200×630）',
  });

  // 7. Robots Index（内容实体默认应收录；noindex 是有意为之时降为提示）
  const noindex = p ? !p.robotsIndex : false;
  checks.push({
    key: 'robotsIndex',
    label: '搜索引擎收录',
    severity: !noindex ? 'passed' : 'warning',
    weight: WEIGHTS.robotsIndex,
    earned: !noindex ? WEIGHTS.robotsIndex : 0,
    message: noindex ? '当前设置为 Noindex（不会进入搜索引擎）' : '允许搜索引擎索引',
    suggestion: noindex ? '如非测试 / 内部页面，建议改回 Index' : undefined,
  });

  // 8. Focus Keyword
  const kw = (p?.focusKeyword ?? '').trim();
  checks.push({
    key: 'focusKeyword',
    label: '焦点关键词',
    severity: kw !== '' ? 'passed' : 'warning',
    weight: WEIGHTS.focusKeyword,
    earned: kw !== '' ? WEIGHTS.focusKeyword : 0,
    message: kw !== '' ? `焦点关键词：${kw}` : '未设置焦点关键词',
    suggestion: kw === '' ? '设置一个焦点关键词用于 SEO 分析参考（禁止在正文堆砌）' : undefined,
  });

  // 9. Schema 类型
  const schemaSet = (p?.schemaType ?? 'NONE') !== 'NONE';
  checks.push({
    key: 'schemaType',
    label: '结构化数据',
    severity: schemaSet ? 'passed' : 'warning',
    weight: WEIGHTS.schemaType,
    earned: schemaSet ? WEIGHTS.schemaType : 0,
    message: schemaSet ? `Schema 类型：${p?.schemaType}` : '未选择 Schema.org 类型',
    suggestion: schemaSet ? undefined : '按页面性质选择 Product / Article / FAQPage 等结构化类型',
  });

  // 10. 图片 Alt 覆盖率
  let altEarned: number = WEIGHTS.altCoverage;
  let altSeverity: SeoCheckSeverity = 'passed';
  let altMessage = '页面无图片，无需 Alt';
  let altSuggestion: string | undefined;
  if (content.imageCount > 0) {
    const ratio = content.imagesWithAlt / content.imageCount;
    altEarned = Math.round((WEIGHTS.altCoverage * ratio + Number.EPSILON) * 100) / 100;
    if (ratio === 1) {
      altMessage = `图片 Alt 覆盖率 100%（${content.imageCount}/${content.imageCount}）`;
    } else if (ratio >= 0.5) {
      altSeverity = 'warning';
      altMessage = `图片 Alt 覆盖率 ${Math.round(ratio * 100)}%（${content.imagesWithAlt}/${content.imageCount}）`;
      altSuggestion = '为剩余图片补充描述性 Alt 文本';
    } else {
      altSeverity = 'error';
      altMessage = `图片 Alt 覆盖率仅 ${Math.round(ratio * 100)}%（${content.imagesWithAlt}/${content.imageCount}）`;
      altSuggestion = '图片 Alt 是图片 SEO 与无障碍的硬性检查项，请尽快补齐';
    }
  }
  checks.push({
    key: 'altCoverage',
    label: '图片 Alt 覆盖率',
    severity: altSeverity,
    weight: WEIGHTS.altCoverage,
    earned: altEarned,
    message: altMessage,
    suggestion: altSuggestion,
  });

  // 11. 内容深度（词数；草稿轻提示）
  let depthEarned: number = WEIGHTS.contentDepth;
  let depthSeverity: SeoCheckSeverity = 'passed';
  let depthMessage = `正文约 ${words} 词`;
  let depthSuggestion: string | undefined;
  if (words < 300 && words > 0) {
    depthEarned = WEIGHTS.contentDepth / 2;
    depthSeverity = 'warning';
    depthMessage = `正文约 ${words} 词，内容偏薄`;
    depthSuggestion = '补充规格、应用、认证等实质性内容（建议 300 词以上）';
  } else if (words === 0) {
    depthEarned = 0;
    depthSeverity = content.isPublished ? 'error' : 'warning';
    depthMessage = '正文为空';
    depthSuggestion = '页面没有正文内容，难以获得排名';
  }
  checks.push({
    key: 'contentDepth',
    label: '内容深度',
    severity: depthSeverity,
    weight: WEIGHTS.contentDepth,
    earned: depthEarned,
    message: depthMessage,
    suggestion: depthSuggestion,
  });

  // 12. 内链（relatedData 非空或正文含站内链接）
  const related = p?.relatedData as Record<string, unknown> | null | undefined;
  const relatedCount = related
    ? ['products', 'posts', 'applications'].reduce(
        (sum, key) => sum + (Array.isArray(related[key]) ? (related[key] as unknown[]).length : 0),
        0,
      )
    : 0;
  const bodyLinks = countInternalLinks(content.content ?? '');
  const linked = relatedCount > 0 || bodyLinks > 0;
  checks.push({
    key: 'internalLinks',
    label: '内链建设',
    severity: linked ? 'passed' : 'warning',
    weight: WEIGHTS.internalLinks,
    earned: linked ? WEIGHTS.internalLinks : 0,
    message: linked
      ? `内链 ${relatedCount + bodyLinks} 处（相关内容 ${relatedCount} + 正文链接 ${bodyLinks}）`
      : '没有相关内容关联或正文内链',
    suggestion: linked ? undefined : '在 SEO 编辑器中关联相关产品 / 文章 / 应用场景',
  });

  const score = Math.min(
    100,
    Math.round(checks.reduce((sum, c) => sum + c.earned, 0)),
  );

  return {
    score,
    checks,
    errorCount: checks.filter((c) => c.severity === 'error').length,
    warningCount: checks.filter((c) => c.severity === 'warning').length,
    passedCount: checks.filter((c) => c.severity === 'passed').length,
  };
}

/** 分数 → 状态档位 */
export function scoreToStatus(score: number): 'GOOD' | 'NEEDS_IMPROVEMENT' | 'POOR' {
  if (score >= SEO_SCORE_THRESHOLDS.GOOD) return 'GOOD';
  if (score >= SEO_SCORE_THRESHOLDS.NEEDS_IMPROVEMENT) return 'NEEDS_IMPROVEMENT';
  return 'POOR';
}
