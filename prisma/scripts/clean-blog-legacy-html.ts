/**
 * 回填脚本：清洗存量博客正文 HTML 与摘要（Phase：文章样式整改）
 *
 * 背景（见 bailing-ui/docs/article-style-diff-report.md）：
 *   Phase 5.4 从 WordPress 迁移时把源站 HTML 原样入库，未过 rich-text.sanitizer。
 *   存量正文因此带着三代样式约定：① Tailwind 工具类（旧站无 Tailwind 时是死类，
 *   新站 utilities 层会覆盖 .blog-prose，造成文章间排版不一致）；② WP 运行时
 *   注入物（emoji img / wp-image-* class / data-attachment-*）；③ 旧站内联
 *   盒式标题样式（border-left + 背景）。
 *   excerpt 则是 WP 自动摘要（半截句 + `[&hellip;]` 字面量）。
 *
 * 清洗规则（纯函数实现与单测见 src/modules/cms/blog/blog-html-cleaner.ts）：
 *   1. emoji img（s.w.org / twemoji，alt 为 emoji 字符）→ 还原为 Unicode 字符；
 *   2. 带 border-left + 背景内联样式的标题 → 受控 class `prose-boxed-heading`
 *      （旧视觉语义由 .blog-prose 中对应 CSS 规则承接）；
 *   3. sanitizeRichText：剥掉全部 class / style / data-* / srcset / id（受控 class 除外）；
 *   4. <table> 包裹 <div class="prose-table-scroll">（移动端横向滚动，语义保留）；
 *   5. excerpt：自动截断摘要（解码后以 […] 结尾或为空）→ 用正文首段重建；
 *      人工摘要仅做实体解码。
 *
 * 安全约束：
 *   · 默认 DRY-RUN（只预览不写入）；--apply 才落库
 *   · 落库前把受影响字段原文写入 prisma/scripts/.backups/*.json（可逐字段恢复）
 *   · 幂等：重复执行第二次输出 0 条待清洗
 *   · 环境断言：仅允许本地开发库（DATABASE_URL host 为 localhost/127.0.0.1
 *     且库名不含 _e2e），否则 --apply 拒绝执行
 *   · --only=excerpt|content|all 分范围执行（默认 all）
 *
 * 用法：
 *   npx ts-node prisma/scripts/clean-blog-legacy-html.ts                  # dry-run
 *   npx ts-node prisma/scripts/clean-blog-legacy-html.ts --only=excerpt   # 只清洗摘要
 *   npx ts-node prisma/scripts/clean-blog-legacy-html.ts --apply          # 写入（先备份）
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import {
  analyzeBlogContentHtml,
  cleanBlogContentHtml,
  cleanBlogExcerpt,
} from '../../src/modules/cms/blog/blog-html-cleaner';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? 'all') as
  | 'excerpt'
  | 'content'
  | 'all';

/* ------------------------------------------------------------------ *
 * 环境断言：只允许本地开发库
 * ------------------------------------------------------------------ */
function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, '..', '..', '.env');
  const raw = fs.readFileSync(envPath, 'utf8');
  const m = /^DATABASE_URL=(.*)$/m.exec(raw);
  if (!m) throw new Error('.env 中未找到 DATABASE_URL');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function assertLocalDatabase(): void {
  const url = loadDatabaseUrl();
  const parsed = new URL(url);
  const host = parsed.hostname;
  const db = parsed.pathname.replace(/^\//, '');
  const localHosts = ['localhost', '127.0.0.1', '::1'];
  const isLocal = localHosts.includes(host);
  const isE2E = db.includes('_e2e');
  console.log(`[db] ${host}/${db}  (local=${isLocal}, e2e=${isE2E})`);
  if (!isLocal) {
    throw new Error(`拒绝执行：DATABASE_URL 非本地库（${host}/${db}）。本脚本只允许本地开发库。`);
  }
  if (isE2E) {
    throw new Error(`拒绝执行：目标是 e2e 测试库（${db}）。请指向 bailingwooden 开发库。`);
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
interface BackupRow {
  id: string;
  slug: string;
  excerptBefore: string | null;
  contentBefore: string;
}

async function main() {
  assertLocalDatabase();

  const posts = await prisma.blogPost.findMany({
    select: { id: true, slug: true, excerpt: true, content: true },
    orderBy: { publishedAt: 'desc' },
  });

  console.log(`\n[blog posts total]  ${posts.length}   (scope: ${ONLY})`);

  const rows: Array<{
    id: string;
    slug: string;
    excerptBefore: string;
    excerptAfter: string;
    contentBefore: string;
    contentAfter: string;
    stats: ReturnType<typeof analyzeBlogContentHtml>;
  }> = [];

  for (const p of posts) {
    const excerptAfter = ONLY === 'content' ? (p.excerpt ?? '') : cleanBlogExcerpt(p.excerpt, p.content);
    const contentAfter = ONLY === 'excerpt' ? p.content : cleanBlogContentHtml(p.content);
    if (excerptAfter === (p.excerpt ?? '') && contentAfter === p.content) continue;
    rows.push({
      id: p.id,
      slug: p.slug,
      excerptBefore: p.excerpt ?? '',
      excerptAfter,
      contentBefore: p.content,
      contentAfter,
      stats: analyzeBlogContentHtml(p.content),
    });
  }

  console.log(`[to be cleaned]     ${rows.length}`);
  if (rows.length === 0) {
    console.log('\n无需清洗（幂等验证通过）。');
    return;
  }

  const emojiTotal = rows.reduce((s, r) => s + r.stats.emoji, 0);
  const boxedTotal = rows.reduce((s, r) => s + r.stats.boxed, 0);
  const tableTotal = rows.reduce((s, r) => s + r.stats.tables, 0);
  console.log(
    `[rule hits]         emoji→unicode: ${emojiTotal}  boxed-heading→class: ${boxedTotal}  table-wrap: ${tableTotal}`,
  );

  console.log('\n— 待清洗文章（前 10 条） —');
  for (const r of rows.slice(0, 10)) {
    console.log(
      `  · ${r.slug}  excerpt ${r.excerptBefore.length}→${r.excerptAfter.length}  content ${r.contentBefore.length}→${r.contentAfter.length}`,
    );
    console.log(`    excerpt after: ${r.excerptAfter.slice(0, 110)}`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN 模式，未写入。落库请显式加 --apply（会自动先写备份）。');
    return;
  }

  // 备份：受影响字段原文（可逐字段恢复）
  const backupDir = path.join(__dirname, '.backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `blog-legacy-cleanup-${stamp}.json`);
  const backup: BackupRow[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    excerptBefore: r.excerptBefore,
    contentBefore: r.contentBefore,
  }));
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 1), 'utf8');
  console.log(`\n[backup] ${backupPath}  (${backup.length} rows)`);

  console.log('\n— 写入中 —');
  let written = 0;
  for (const r of rows) {
    await prisma.blogPost.update({
      where: { id: r.id },
      data: {
        ...(ONLY === 'content' ? {} : { excerpt: r.excerptAfter }),
        ...(ONLY === 'excerpt' ? {} : { content: r.contentAfter }),
      },
    });
    written += 1;
  }
  console.log(`[written] ${written}`);
  console.log('\n完成。重跑本脚本应输出 [to be cleaned] 0（幂等）。');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
