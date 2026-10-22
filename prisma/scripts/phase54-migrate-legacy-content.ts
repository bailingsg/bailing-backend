/**
 * Phase 5.4.3b - 旧站产品与文章迁移脚本（幂等、可重复执行、dry-run 默认）。
 *
 * 数据源（docs/migration/legacy-raw/）：
 *   products-all.json / posts-all.json / terms-*.json
 *   legacy-image-index.json（本地图片索引，含 manifest 元数据）
 *   C:/Users/Administrator/Desktop/bailing-image-export/（本地图片实体）
 *
 * 幂等机制（任务 7.1：目标库无源站 ID 字段 → 来源映射表 + slug 唯一键）：
 *   - 台账 legacy-migration-ledger.json：legacyAttachmentId -> MediaAsset 等映射
 *   - 产品/文章按 slug 匹配既有记录（update）而非重复创建
 *   - 分类/博客分类/标签按 slug upsert
 *
 * 上架策略（任务 7.3）：
 *   - 产品图片 4-10 张且描述非空 -> PUBLISHED；否则 DRAFT（不伪造图片关系）
 *   - 文章按源站发布状态（全部 publish -> PUBLISHED）
 *
 * 用法：
 *   npx ts-node prisma/scripts/phase54-migrate-legacy-content.ts          # dry-run
 *   npx ts-node prisma/scripts/phase54-migrate-legacy-content.ts --apply  # 写入
 */
import { ContentEntityType, PrismaClient } from '@prisma/client';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const MIGRATION_DIR = path.join(process.cwd(), 'docs', 'migration');
const RAW_DIR = path.join(MIGRATION_DIR, 'legacy-raw');
const IMAGE_EXPORT_DIR = 'C://Users//Administrator//Desktop//bailing-image-export';
const LEDGER_PATH = path.join(MIGRATION_DIR, 'legacy-migration-ledger.json');
const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');
const UPLOADS_BASE_URL = (process.env.UPLOADS_BASE_URL ?? 'http://192.168.1.40:4000').replace(/\/$/, '');
const MIGRATION_DATE = '2026/10'; // 媒体存储年月目录

const SITE_TITLE_SUFFIX = / - Shouguang Bailing Wood Industry \| MDF, Plywood & Decorative Materials$/;
const MIN_PRODUCT_IMAGES = 4;
const MAX_PRODUCT_IMAGES = 10;

interface ManifestRow {
  localPath: string;
  origUrl: string;
  bucket: string;
  owner: string;
  order: string;
  attachmentId: string;
  alt: string;
  caption: string;
  width: string;
  height: string;
  uploadRelPath: string;
  uploadDate: string;
  referencedBy: string;
  downloadStatus: string;
}

interface ImageIndexEntry {
  localPath: string;
  absolutePath: string;
  filename: string;
  ext: string;
  sizeBytes: number;
  width: number | string | null;
  height: number | string | null;
  sha256: string;
  manifest: ManifestRow | null;
  inManifest: boolean;
}

interface Ledger {
  meta: Record<string, unknown>;
  attachments: Record<string, { mediaAssetId: string; storageKey: string; url: string; filename: string; sha256: string }>;
  products: Record<string, { productId: string; slug: string; status: string; imageCount: number; galleryAttachmentIds: string[] }>;
  posts: Record<string, { blogPostId: string; slug: string; status: string; coverAttachmentId: string | null; inlineRewrites: number; inlineUnmatched: string[] }>;
  categories: Record<string, { categoryId: string; slug: string }>;
  blogCategories: Record<string, { blogCategoryId: string; slug: string }>;
  blogTags: Record<string, { blogTagId: string; slug: string }>;
}

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, c) => String.fromCodePoint(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function yoast(obj: any): any {
  const y = obj?.yoast_head_json;
  return y && typeof y === 'object' ? y : {};
}

function cleanSeoTitle(t: string | undefined): string | null {
  if (!t) return null;
  const cleaned = t.replace(SITE_TITLE_SUFFIX, '').trim();
  return cleaned || null;
}

/** 图片 URL 归一化：取路径部分（去域名/查询参数/尺寸后缀）。
 *  正文图片可能经 Jetpack CDN（i0.wp.com/bailingwooden.com/...）引用，
 *  清单 原始URL 为主域名，二者路径一致 → 按路径匹配可同时命中。 */
function normalizeImageUrl(url: string): string {
  let p = url;
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  const hash = p.indexOf('#');
  if (hash >= 0) p = p.slice(0, hash);
  const uploads = p.indexOf('/wp-content/uploads/');
  if (uploads >= 0) p = p.slice(uploads);
  return p.replace(/-(\d+)x(\d+)(\.[a-z0-9]+)$/i, '$3').toLowerCase();
}

/** 外部资源（非旧站图片，不参与迁移匹配）：WP 核心 emoji 等 */
function isExternalAsset(url: string): boolean {
  return !/bailingwooden\.com/i.test(url);
}

function mimeByExt(ext: string): string {
  const map: Record<string, string> = {
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

function orderOf(row: ManifestRow): number {
  const s = (row.order ?? '').toString().trim();
  if (s !== '') return Number(s);
  const m = /^(\d+)_/.exec(row.localPath.split('/').pop() ?? '');
  return m ? Number(m[1]) : 999;
}

/** 从正文 HTML 的表格解析规格键值对（保守：仅 th/td 两列或首列在内的行） */
function parseSpecs(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(html))) {
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(tm[1]))) {
      const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
      const cells: string[] = [];
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1]))) cells.push(stripTags(cm[2]));
      if (cells.length >= 2) {
        const key = cells[0].trim();
        const value = cells.slice(1).join(' / ').trim();
        if (key && value && !(key in specs)) specs[key] = value;
      }
    }
  }
  return specs;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? '';
  let fp = '(unparseable)';
  try {
    const u = new URL(dbUrl);
    fp = `${u.hostname}:${u.port || '5432'}${u.pathname}?`;
  } catch { /* noop */ }
  console.log(`[guard] DATABASE_URL 指纹: ${fp}`);
  if (!fp.startsWith('127.0.0.1:5432/bailingwooden?')) {
    console.error(`[BLOCKED] 非本地开发库（实测 ${fp}），迁移只允许写入 bailingwooden。已中止。`);
    process.exit(3);
  }
  console.log(`[mode] ${APPLY ? 'APPLY（写入）' : 'DRY-RUN（演练）'}`);

  // ---------- 1. 加载源数据 ----------
  const products = loadJson<any[]>(path.join(RAW_DIR, 'products-all.json'));
  const posts = loadJson<any[]>(path.join(RAW_DIR, 'posts-all.json'));
  const rawImageIndex = loadJson<any[]>(path.join(MIGRATION_DIR, 'legacy-image-index.json'));
  // 索引文件的 manifest 为中文 CSV 列名，归一化为脚本内部结构
  const imageIndex: ImageIndexEntry[] = rawImageIndex.map((e) => {
    const m = e.manifest;
    const manifest: ManifestRow | null = m
      ? {
          localPath: m['本地路径'] ?? '',
          origUrl: m['原始URL'] ?? '',
          bucket: m['分类'] ?? '',
          owner: m['归属(产品/文章/页面slug)'] ?? '',
          order: m['图集顺序'] ?? '',
          attachmentId: String(m['附件ID'] ?? ''),
          alt: m['图像ALT'] ?? '',
          caption: m['图像Caption'] ?? '',
          width: m['宽'] ?? '',
          height: m['高'] ?? '',
          uploadRelPath: m['上传相对路径'] ?? '',
          uploadDate: m['上传日期'] ?? '',
          referencedBy: m['出现页面'] ?? '',
          downloadStatus: m['下载状态'] ?? '',
        }
      : null;
    return { ...e, manifest } as ImageIndexEntry;
  });
  const termsProductCat = loadJson<Record<string, any>>(path.join(RAW_DIR, 'terms-product_cat.json'));
  let termsProductTag: Record<string, any> = {};
  let termsBlogCat: Record<string, any> = {};
  let termsBlogTag: Record<string, any> = {};
  try { termsProductTag = loadJson(path.join(RAW_DIR, 'terms-product_tag.json')); } catch { /* 允许缺省 */ }
  try { termsBlogCat = loadJson(path.join(RAW_DIR, 'terms-categories.json')); } catch { /* 允许缺省 */ }
  try { termsBlogTag = loadJson(path.join(RAW_DIR, 'terms-tags.json')); } catch { /* 允许缺省 */ }

  let ledger: Ledger = {
    meta: {},
    attachments: {},
    products: {},
    posts: {},
    categories: {},
    blogCategories: {},
    blogTags: {},
  };
  if (existsSync(LEDGER_PATH)) {
    try {
      const existing = loadJson<Ledger>(LEDGER_PATH);
      ledger = { ...ledger, ...existing };
    } catch { /* 台账损坏则重建，由 slug 幂等兜底 */ }
  }

  // 附件注册表：attachmentId -> 索引条目
  const attachments = new Map<string, ImageIndexEntry>();
  for (const e of imageIndex) {
    const aid = e.manifest?.attachmentId;
    if (aid && !attachments.has(aid)) attachments.set(aid, e);
  }
  // 原始URL -> attachmentId（用于正文内嵌图匹配）
  const byOrigUrl = new Map<string, string>();
  for (const [aid, e] of attachments) {
    const u = e.manifest?.origUrl;
    if (u) byOrigUrl.set(normalizeImageUrl(u), aid);
  }

  const admin = await prisma.adminUser.findFirst({
    where: { email: { in: ['admin@bailingwooden.com'] } },
    select: { id: true, email: true },
  });
  if (!admin) {
    console.error('[BLOCKED] 未找到 admin@bailingwooden.com（清理后应存在）。已中止。');
    process.exit(3);
  }
  console.log(`[info] 迁移执行账号（媒体 createdBy）: ${admin.email}`);

  // ---------- 2. 媒体注册（幂等：ledger 优先，库内校验） ----------
  const mediaResults = { registered: 0, reused: 0, failed: 0, skippedNoFile: 0 };
  const attachmentFailures: string[] = [];

  async function ensureMedia(attachmentId: string): Promise<{ url: string; storageKey: string; filename: string } | null> {
    const entry = attachments.get(attachmentId);
    if (!entry?.manifest) return null;
    const srcPath = path.join(IMAGE_EXPORT_DIR, entry.localPath);
    if (!existsSync(srcPath)) {
      attachmentFailures.push(`${attachmentId}:${entry.localPath}`);
      return null;
    }
    const cached = ledger.attachments[attachmentId];
    if (cached) {
      const stillThere = await prisma.mediaAsset.findUnique({ where: { id: cached.mediaAssetId }, select: { id: true } });
      if (stillThere && existsSync(path.join(UPLOADS_ROOT, cached.storageKey))) {
        mediaResults.reused += 1;
        return { url: cached.url, storageKey: cached.storageKey, filename: cached.filename };
      }
    }
    const ext = entry.ext || path.extname(entry.filename);
    const filename = `${randomUUID()}${ext}`;
    const storageKey = `media/${MIGRATION_DATE}/${filename}`;
    const url = `${UPLOADS_BASE_URL}/uploads/${storageKey}`;
    if (!APPLY) {
      ledger.attachments[attachmentId] = { mediaAssetId: '(dry-run)', storageKey, url, filename, sha256: entry.sha256 };
      mediaResults.registered += 1;
      return { url, storageKey, filename };
    }
    const destPath = path.join(UPLOADS_ROOT, storageKey);
    if (!existsSync(destPath)) {
      mkdirSync(path.dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
    const mime = mimeByExt(ext);
    const asset = await prisma.mediaAsset.create({
      data: {
        filename,
        originalName: entry.filename,
        storageKey,
        url,
        mimeType: mime,
        size: entry.sizeBytes,
        width: typeof entry.width === 'number' ? entry.width : null,
        height: typeof entry.height === 'number' ? entry.height : null,
        altText: entry.manifest.alt || null,
        title: null,
        caption: entry.manifest.caption || null,
        provider: 'LOCAL',
        category: 'IMAGE',
        createdBy: admin!.id,
      },
      select: { id: true },
    });
    ledger.attachments[attachmentId] = { mediaAssetId: asset.id, storageKey, url, filename, sha256: entry.sha256 };
    mediaResults.registered += 1;
    return { url, storageKey, filename };
  }

  // ---------- 3. 术语解析（幂等 upsert） ----------
  async function ensureCategory(legacyId: string): Promise<{ id: string; slug: string } | null> {
    const cached = ledger.categories[legacyId];
    if (cached) {
      const row = await prisma.category.findUnique({ where: { id: cached.categoryId }, select: { id: true } });
      if (row) return { id: row.id, slug: cached.slug };
    }
    const t = termsProductCat[legacyId];
    if (!t?.slug) return null;
    const existing = await prisma.category.findUnique({ where: { slug: t.slug }, select: { id: true } });
    if (existing) {
      ledger.categories[legacyId] = { categoryId: existing.id, slug: t.slug };
      return { id: existing.id, slug: t.slug };
    }
    if (!APPLY) {
      ledger.categories[legacyId] = { categoryId: '(dry-run)', slug: t.slug };
      return { id: '(dry-run)', slug: t.slug };
    }
    const created = await prisma.category.create({
      data: { name: t.name, slug: t.slug, description: t.description ? stripTags(t.description).slice(0, 500) || null : null, sortOrder: 0 },
      select: { id: true },
    });
    ledger.categories[legacyId] = { categoryId: created.id, slug: t.slug };
    return { id: created.id, slug: t.slug };
  }

  async function ensureBlogCategory(legacyId: string): Promise<{ id: string; slug: string } | null> {
    const cached = ledger.blogCategories[legacyId];
    if (cached) {
      const row = await prisma.blogCategory.findUnique({ where: { id: cached.blogCategoryId }, select: { id: true } });
      if (row) return { id: row.id, slug: cached.slug };
    }
    const t = termsBlogCat[legacyId];
    if (!t?.slug) return null;
    const existing = await prisma.blogCategory.findUnique({ where: { slug: t.slug }, select: { id: true } });
    if (existing) {
      ledger.blogCategories[legacyId] = { blogCategoryId: existing.id, slug: t.slug };
      return { id: existing.id, slug: t.slug };
    }
    if (!APPLY) {
      ledger.blogCategories[legacyId] = { blogCategoryId: '(dry-run)', slug: t.slug };
      return { id: '(dry-run)', slug: t.slug };
    }
    const created = await prisma.blogCategory.create({
      data: { name: t.name, slug: t.slug, description: t.description ? stripTags(t.description).slice(0, 500) || null : null, sortOrder: 0 },
      select: { id: true },
    });
    ledger.blogCategories[legacyId] = { blogCategoryId: created.id, slug: t.slug };
    return { id: created.id, slug: t.slug };
  }

  async function ensureBlogTag(legacyId: string): Promise<{ id: string; slug: string } | null> {
    const cached = ledger.blogTags[legacyId];
    if (cached) {
      const row = await prisma.blogTag.findUnique({ where: { id: cached.blogTagId }, select: { id: true } });
      if (row) return { id: row.id, slug: cached.slug };
    }
    const t = termsBlogTag[legacyId];
    if (!t?.slug) return null;
    const existing = await prisma.blogTag.findUnique({ where: { slug: t.slug }, select: { id: true } });
    if (existing) {
      ledger.blogTags[legacyId] = { blogTagId: existing.id, slug: t.slug };
      return { id: existing.id, slug: t.slug };
    }
    if (!APPLY) {
      ledger.blogTags[legacyId] = { blogTagId: '(dry-run)', slug: t.slug };
      return { id: '(dry-run)', slug: t.slug };
    }
    const created = await prisma.blogTag.create({ data: { name: t.name, slug: t.slug }, select: { id: true } });
    ledger.blogTags[legacyId] = { blogTagId: created.id, slug: t.slug };
    return { id: created.id, slug: t.slug };
  }

  // ---------- 3.5 预注册全部产品/文章图片（确保正文内嵌图在 rewrite 前已入库） ----------
  console.log('[media] 预注册产品与文章图片...');
  let preReg = 0;
  for (const e of imageIndex) {
    const m = e.manifest;
    if (m && (m.bucket === 'product' || m.bucket === 'post') && m.attachmentId) {
      await ensureMedia(m.attachmentId);
      preReg += 1;
    }
  }
  console.log(`[media] 预注册完成: ${preReg} 个附件`);

  // ---------- 3.6 正文图片 URL 重写（产品描述与文章正文共用） ----------
  function rewriteContentImages(html: string): {
    content: string;
    rewrites: number;
    unmatched: string[];
    externalIgnored: string[];
  } {
    const unmatched: string[] = [];
    const externalIgnored: string[] = [];
    let rewrites = 0;
    let content = html.replace(
      /(<img\b[^>]*?\ssrc=")([^"]+)(")/gi,
      (full: string, pre: string, src: string, post2: string) => {
        if (isExternalAsset(src)) {
          externalIgnored.push(src);
          return full;
        }
        const aid = byOrigUrl.get(normalizeImageUrl(src));
        const cached = aid ? ledger.attachments[aid] : undefined;
        if (aid && cached && cached.mediaAssetId !== '(dry-run)' && cached.url) {
          rewrites += 1;
          return pre + cached.url + post2;
        }
        if (aid) return full; // 站内图但未注册（dry-run）：原样保留
        unmatched.push(src);
        return full;
      },
    );
    content = content.replace(
      /(srcset=")([^"]+)(")/gi,
      (full: string, pre: string, value: string, post2: string) => {
        if (!value.includes('wp-content')) return full;
        let changed = 0;
        const rewritten = value
          .split(',')
          .map((part: string) => {
            const m = /^(\s*)(\S+)(\s+.*)?$/.exec(part);
            if (!m) return part;
            if (isExternalAsset(m[2])) return part;
            const aid = byOrigUrl.get(normalizeImageUrl(m[2]));
            const cached = aid ? ledger.attachments[aid] : undefined;
            if (aid && cached && cached.mediaAssetId !== '(dry-run)' && cached.url) {
              changed += 1;
              return `${m[1]}${cached.url}${m[3] ?? ''}`;
            }
            return part;
          })
          .join(',');
        if (changed > 0) {
          rewrites += changed;
          return pre + rewritten + post2;
        }
        return full;
      },
    );
    content = content.replace(
      /(data-(?:orig|large|medium)-file=")([^"]+)(")/gi,
      (full: string, pre: string, src: string, post2: string) => {
        if (isExternalAsset(src)) return full;
        const aid = byOrigUrl.get(normalizeImageUrl(src));
        const cached = aid ? ledger.attachments[aid] : undefined;
        if (aid && cached && cached.mediaAssetId !== '(dry-run)' && cached.url) {
          rewrites += 1;
          return pre + cached.url + post2;
        }
        return full;
      },
    );
    return { content, rewrites, unmatched, externalIgnored };
  }

  // ---------- 4. 产品迁移 ----------
  console.log(`\n[products] 源站 ${products.length} 个产品`);
  const productReport: any[] = [];
  const productGallery = new Map<string, ImageIndexEntry[]>();
  for (const e of imageIndex) {
    const m = e.manifest;
    if (m && m.bucket === 'product' && m.owner) {
      if (!productGallery.has(m.owner)) productGallery.set(m.owner, []);
      productGallery.get(m.owner)!.push(e);
    }
  }
  for (const [, arr] of productGallery) arr.sort((a, b) => orderOf(a.manifest!) - orderOf(b.manifest!));

  for (const p of products) {
    const legacyId = String(p.id);
    const slug = p.slug as string;
    const title = decodeEntities(p.title?.rendered ?? '');
    const descRaw = (p.content?.rendered ?? '').trim();
    const descRewrite = rewriteContentImages(descRaw);
    const description = descRewrite.content;
    const excerpt = stripTags(p.excerpt?.rendered ?? '');
    const shortDescription = excerpt ? excerpt.slice(0, 300) : stripTags(description).slice(0, 200) || null;
    const specs = parseSpecs(description);
    const material = specs['Material'] ?? specs['material'] ?? null;
    const legacyCats: string[] = (p.product_cat ?? []).map(String);
    const legacyTags: string[] = (p.product_tag ?? []).map(String);
    const tagNames = legacyTags.map((t) => termsProductTag[t]?.name).filter(Boolean) as string[];
    const y = yoast(p);
    const canonical = (y.canonical as string) || (p.link as string) || null;
    const createdAt = p.date ? new Date(p.date) : new Date();
    const updatedAt = p.modified ? new Date(p.modified) : createdAt;

    const gallery: { attachmentId: string; url: string; alt: string | null }[] = [];
    const seenAid = new Set<string>();
    for (const e of productGallery.get(slug) ?? []) {
      const aid = e.manifest?.attachmentId;
      if (!aid || seenAid.has(aid)) continue;
      seenAid.add(aid);
      const media = await ensureMedia(aid);
      if (media) gallery.push({ attachmentId: aid, url: media.url, alt: e.manifest?.alt || null });
    }

    const cat = legacyCats.length > 0 ? await ensureCategory(legacyCats[0]) : null;
    const imageCount = gallery.length;
    const sourceStatus = p.status === 'publish' ? 'PUBLISHED' : 'DRAFT';
    let status: 'PUBLISHED' | 'DRAFT' = 'DRAFT';
    let statusReason = '';
    if (sourceStatus !== 'PUBLISHED') {
      statusReason = '源站非 publish';
    } else if (!description) {
      statusReason = '正文为空';
    } else if (imageCount < MIN_PRODUCT_IMAGES) {
      statusReason = `图片 ${imageCount} 张 < 最少 ${MIN_PRODUCT_IMAGES} 张，按规则不强行上架`;
    } else if (imageCount > MAX_PRODUCT_IMAGES) {
      statusReason = `图片 ${imageCount} 张 > 最多 ${MAX_PRODUCT_IMAGES} 张，按规则不强行上架`;
    } else if (!cat) {
      statusReason = '无法解析产品分类';
    } else {
      status = 'PUBLISHED';
    }

    productReport.push({
      legacyId, slug, title, legacyCats, legacyTagNames: tagNames,
      imageCount, status, statusReason, specsKeys: Object.keys(specs).length,
      descRewrites: descRewrite.rewrites, descUnmatched: descRewrite.unmatched, descExternalIgnored: descRewrite.externalIgnored.length,
      createdAt, updatedAt, canonical,
    });
    console.log(`  - ${slug.slice(0, 60)} | imgs:${imageCount} | descRewrites:${descRewrite.rewrites} | ${status}${statusReason ? ' | ' + statusReason : ''}`);

    if (!APPLY) {
      ledger.products[legacyId] = { productId: '(dry-run)', slug, status, imageCount, galleryAttachmentIds: gallery.map((g) => g.attachmentId) };
      continue;
    }

    if (!cat) {
      console.warn(`    [skip] ${slug} 无分类且源站 publish，无法创建（FK 必填）`);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { slug }, select: { id: true } });
      const data = {
        name: title,
        slug,
        shortDescription,
        description,
        categoryId: cat.id,
        material,
        applications: tagNames.length > 0 ? tagNames : undefined,
        specifications: Object.keys(specs).length > 0 ? specs : undefined,
        status: status as any,
        isFeatured: false,
        seoTitle: cleanSeoTitle(y.title),
        seoDescription: (y.description as string) || null,
        version: 1,
        publishedVersion: status === 'PUBLISHED' ? 1 : 0,
        createdAt,
        updatedAt,
      };
      let productId: string;
      if (existing) {
        await tx.product.update({ where: { id: existing.id }, data });
        productId = existing.id;
        await tx.productImage.deleteMany({ where: { productId } });
      } else {
        const created = await tx.product.create({ data, select: { id: true } });
        productId = created.id;
      }
      for (let i = 0; i < gallery.length; i++) {
        await tx.productImage.create({
          data: {
            productId,
            url: gallery[i].url,
            altText: gallery[i].alt,
            sortOrder: i,
            isPrimary: i === 0,
          },
        });
      }
      ledger.products[legacyId] = { productId, slug, status, imageCount, galleryAttachmentIds: gallery.map((g) => g.attachmentId) };
    });
  }

  // ---------- 5. 文章迁移 ----------
  console.log(`\n[posts] 源站 ${posts.length} 篇文章`);
  const postReport: any[] = [];
  const postImages = new Map<string, ImageIndexEntry[]>();
  for (const e of imageIndex) {
    const m = e.manifest;
    if (m && m.bucket === 'post' && m.owner) {
      if (!postImages.has(m.owner)) postImages.set(m.owner, []);
      postImages.get(m.owner)!.push(e);
    }
  }

  for (const post of posts) {
    const legacyId = String(post.id);
    const slug = post.slug as string;
    const title = decodeEntities(post.title?.rendered ?? '');
    let content = post.content?.rendered ?? '';
    const postRewrite = rewriteContentImages(content);
    content = postRewrite.content;
    const unmatched = postRewrite.unmatched;
    const externalIgnored = postRewrite.externalIgnored;
    let inlineRewrites = postRewrite.rewrites;
    const excerpt = stripTags(post.excerpt?.rendered ?? '');
    const legacyCats: string[] = (post.categories ?? []).map(String);
    const legacyTags: string[] = (post.tags ?? []).map(String);
    const canonical = (post.link as string) || null;
    const createdAt = post.date ? new Date(post.date) : new Date();
    const updatedAt = post.modified ? new Date(post.modified) : createdAt;
    const publishedAt = post.date ? new Date(post.date) : null;

    // 封面图
    let cover: { url: string; attachmentId: string } | null = null;
    const featured = post.featured_media ? String(post.featured_media) : null;
    if (featured && attachments.has(featured)) {
      const media = await ensureMedia(featured);
      if (media) cover = { url: media.url, attachmentId: featured };
    }

    const cat = legacyCats.length > 0 ? await ensureBlogCategory(legacyCats[0]) : null;
    const status = post.status === 'publish' && content.trim().length > 0 ? 'PUBLISHED' : 'DRAFT';
    const statusReason = status === 'PUBLISHED' ? '' : post.status !== 'publish' ? '源站非 publish' : '正文为空';

    postReport.push({
      legacyId, slug, title, legacyCats, legacyTagCount: legacyTags.length,
      coverAttachmentId: cover?.attachmentId ?? null, inlineRewrites, inlineUnmatched: unmatched,
      externalIgnored: externalIgnored.length,
      status, statusReason, createdAt, updatedAt, canonical,
    });
    console.log(`  - ${slug.slice(0, 55)} | cover:${cover?.attachmentId ?? '-'} | rewrites:${inlineRewrites} | unmatched:${unmatched.length} | ext:${externalIgnored.length} | ${status}`);

    if (!APPLY) {
      ledger.posts[legacyId] = { blogPostId: '(dry-run)', slug, status, coverAttachmentId: cover?.attachmentId ?? null, inlineRewrites, inlineUnmatched: unmatched };
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const existing = await tx.blogPost.findUnique({ where: { slug }, select: { id: true } });
      const data = {
        title,
        slug,
        excerpt: excerpt ? excerpt.slice(0, 500) : null,
        content,
        coverImageUrl: cover?.url ?? null,
        coverMediaId: cover && ledger.attachments[cover.attachmentId]?.mediaAssetId !== '(dry-run)'
          ? ledger.attachments[cover.attachmentId].mediaAssetId
          : null,
        categoryId: cat?.id ?? null,
        status: status as any,
        version: 1,
        publishedVersion: status === 'PUBLISHED' ? 1 : 0,
        featured: false,
        publishedAt,
        authorId: null,
        seoTitle: cleanSeoTitle(yoast(post).title),
        seoDescription: (yoast(post).description as string) || null,
        canonicalUrl: canonical,
        createdAt,
        updatedAt,
      };
      let postId: string;
      if (existing) {
        await tx.blogPost.update({ where: { id: existing.id }, data });
        postId = existing.id;
        await tx.blogPostTag.deleteMany({ where: { postId } });
      } else {
        const created = await tx.blogPost.create({ data, select: { id: true } });
        postId = created.id;
      }
      for (const t of legacyTags) {
        const tag = await ensureBlogTag(t);
        if (tag && tag.id !== '(dry-run)') {
          await tx.blogPostTag.create({ data: { postId, tagId: tag.id } });
        }
      }
      ledger.posts[legacyId] = { blogPostId: postId, slug, status, coverAttachmentId: cover?.attachmentId ?? null, inlineRewrites, inlineUnmatched: unmatched };
    });
  }

  // ---------- 6. 台账与报告 ----------
  ledger.meta = {
    updatedAt: new Date().toISOString(),
    apply: APPLY,
    sourceProducts: products.length,
    sourcePosts: posts.length,
  };
  if (APPLY) {
    writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 1), 'utf-8');
  }
  const report = {
    mode: APPLY ? 'apply' : 'dry-run',
    generatedAt: new Date().toISOString(),
    source: { products: products.length, posts: posts.length },
    media: mediaResults,
    attachmentFailures,
    products: productReport,
    posts: postReport,
  };
  writeFileSync(path.join(MIGRATION_DIR, 'migration-run-report.json'), JSON.stringify(report, null, 1), 'utf-8');
  console.log('\n[done] 台账:', LEDGER_PATH);
  console.log('[done] 运行报告:', path.join(MIGRATION_DIR, 'migration-run-report.json'));
  console.log(`[summary] media registered=${mediaResults.registered} reused=${mediaResults.reused} failed=${attachmentFailures.length}`);
}

main()
  .catch((e) => {
    console.error('[FATAL]', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
