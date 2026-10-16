import type { MediaAsset, SiteSection } from '@prisma/client';
import {
  parseSiteSectionItems,
  parseSiteSectionStats,
  type SiteSectionItemDto,
  type SiteSectionStatDto,
} from '../../cms/site/entities/site.entity';

/**
 * 站点内容公开实体（Phase 4.7）。
 *
 * 白名单原则：只暴露渲染所需字段；media 不含 storageKey / provider / createdBy；
 * items / stats 经 CMS 侧同款白名单解析（读出时双保险）。
 */

export interface PublicSiteMediaRef {
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

export interface PublicSiteSection {
  sectionKey: string;
  eyebrow: string | null;
  title: string | null;
  subtitle: string | null;
  body: string | null;
  media: PublicSiteMediaRef | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  items: SiteSectionItemDto[];
  stats: SiteSectionStatDto[];
  publishedAt: string | null;
}

export interface PublicNavItem {
  id: string;
  label: string;
  url: string;
  sortOrder: number;
  openInNewTab: boolean;
}

type SiteSectionPublicRow = SiteSection & { media: MediaAsset | null };

export function toPublicSiteSection(row: SiteSectionPublicRow): PublicSiteSection {
  return {
    sectionKey: row.sectionKey,
    eyebrow: row.eyebrow,
    title: row.title,
    subtitle: row.subtitle,
    body: row.body,
    media: row.media
      ? {
          url: row.media.url,
          altText: row.media.altText,
          width: row.media.width,
          height: row.media.height,
        }
      : null,
    ctaLabel: row.ctaLabel,
    ctaUrl: row.ctaUrl,
    items: parseSiteSectionItems(row.items),
    stats: parseSiteSectionStats(row.stats),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}
