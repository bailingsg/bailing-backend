import type { MediaAsset, NavItem, SiteSection } from '@prisma/client';

/**
 * 站点内容 CMS 响应实体（Phase 4.7）。
 *
 * 白名单原则：只暴露运营需要的字段；media 只含 url / altText 等展示字段，
 * 不透出 storageKey / provider / createdBy。
 */

export interface SiteSectionMediaRefDto {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
}

export interface SiteSectionItemDto {
  title: string;
  description: string | null;
  href: string | null;
}

export interface SiteSectionStatDto {
  label: string;
  value: string;
}

export interface SiteSectionDto {
  id: string;
  page: string;
  sectionKey: string;
  eyebrow: string | null;
  title: string | null;
  subtitle: string | null;
  body: string | null;
  media: SiteSectionMediaRefDto | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  items: SiteSectionItemDto[];
  stats: SiteSectionStatDto[];
  status: string;
  sortOrder: number;
  publishedAt: string | null;
  /** 线上版本号（0 = 从未发布）。Phase 1 版本隔离后由发布动作递增 */
  publishedVersion: number;
  /** 是否存在未发布的编辑稿（保存≠发布） */
  hasUnpublishedChanges: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SiteSectionListDto {
  items: SiteSectionDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface NavItemDto {
  id: string;
  location: string;
  label: string;
  url: string;
  sortOrder: number;
  isActive: boolean;
  openInNewTab: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NavItemListDto {
  items: NavItemDto[];
  total: number;
}

/* ------------------------------ 运行期白名单校验 ------------------------------ */

const MAX_ITEMS = 8;
const MAX_STATS = 6;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
};

/**
 * 解析 items JSON 为白名单结构。
 *
 * 数据库中的值可能来自历史写入或直接改库，因此**读出时同样校验**：
 * 非数组 / 超长 / 字段缺失一律降级为空数组，绝不让脏数据流到前台。
 */
export function parseSiteSectionItems(value: unknown): SiteSectionItemDto[] {
  if (!Array.isArray(value)) return [];
  const out: SiteSectionItemDto[] = [];
  for (const raw of value) {
    if (out.length >= MAX_ITEMS) break;
    const row = asRecord(raw);
    if (!row) continue;
    const title = asString(row.title, 120);
    if (!title) continue;
    const description = row.description === undefined || row.description === null
      ? null
      : asString(row.description, 400);
    const href = row.href === undefined || row.href === null
      ? null
      : asString(row.href, 300);
    out.push({ title, description, href });
  }
  return out;
}

/** 解析 stats JSON 为白名单结构 [{label, value}]（读出时同样校验） */
export function parseSiteSectionStats(value: unknown): SiteSectionStatDto[] {
  if (!Array.isArray(value)) return [];
  const out: SiteSectionStatDto[] = [];
  for (const raw of value) {
    if (out.length >= MAX_STATS) break;
    const row = asRecord(raw);
    if (!row) continue;
    const label = asString(row.label, 40);
    const statValue = asString(row.value, 40);
    if (!label || !statValue) continue;
    out.push({ label, value: statValue });
  }
  return out;
}

/* ------------------------------ 行 → DTO ------------------------------ */

type SiteSectionRow = SiteSection & { media: MediaAsset | null };

export function toSiteSectionDto(row: SiteSectionRow, hasUnpublishedChanges = false): SiteSectionDto {
  return {
    id: row.id,
    page: row.page,
    sectionKey: row.sectionKey,
    eyebrow: row.eyebrow,
    title: row.title,
    subtitle: row.subtitle,
    body: row.body,
    media: row.media
      ? {
          id: row.media.id,
          url: row.media.url,
          altText: row.media.altText,
          width: row.media.width,
          height: row.media.height,
          mimeType: row.media.mimeType,
        }
      : null,
    ctaLabel: row.ctaLabel,
    ctaUrl: row.ctaUrl,
    items: parseSiteSectionItems(row.items),
    stats: parseSiteSectionStats(row.stats),
    status: row.status,
    sortOrder: row.sortOrder,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    publishedVersion: row.publishedVersion,
    hasUnpublishedChanges,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toNavItemDto(row: NavItem): NavItemDto {
  return {
    id: row.id,
    location: row.location,
    label: row.label,
    url: row.url,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    openInNewTab: row.openInNewTab,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
