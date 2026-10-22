/**
 * 存量清洗脚本：移除正文里写死的联系方式与经验年限宣传语
 *
 * 背景：Phase 5.4 从 WordPress 迁移时原样入库的正文，末尾带着写死的联系方式
 * 签名块（`📧 Email:+86 131 5688 9006` / `🌐 Website:` / `📍 Factory: ... (26 years
 * of experience)`），部分文章还带旧站页脚块（`WhatsApp+8613156889006`）与写死邮箱。
 * 这些信息应来自 CMS（员工联系卡 / 站点设置 seo_settings.company*），写死在正文
 * 里会过期、且把内部号码暴露给搜索引擎。
 *
 * 规则实现（纯函数 + 单测见 src/modules/cms/blog/contact-block-cleaner.ts）：
 *   1. stripHardcodedContacts：签名段 / wa.me 锚点 / 写死邮箱 li / 残留号码邮箱；
 *   2. stripExperienceClaims：`26 years of experience` 类年限宣传语（语法安全改写，
 *      不动表格里的 `20-Year Maintenance` 等数据型表述）；
 *   3. sanitizeRichText：统一过写入端净化，保证存库形态与后台保存一致；
 *   4. 文章 excerpt 若命中联系方式则按正文首段重建。
 *
 * 安全约束：
 *   · 默认 DRY-RUN；--apply 才落库
 *   · 落库前把受影响字段原文写入 prisma/scripts/.backups/*.json
 *   · 幂等：重复执行第二次 0 条待清洗
 *   · 环境断言：仅本地开发库（host 为 localhost/127.0.0.1 且库名不含 _e2e）
 *
 * 用法：
 *   npx ts-node prisma/scripts/remove-hardcoded-contacts.ts           # dry-run
 *   npx ts-node prisma/scripts/remove-hardcoded-contacts.ts --apply   # 写入
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { cleanBlogExcerpt } from '../../src/modules/cms/blog/blog-html-cleaner';
import { sanitizeRichText } from '../../src/modules/cms/blog/rich-text.sanitizer';
import {
  hasExperienceClaims,
  hasHardcodedContacts,
  stripExperienceClaims,
  stripHardcodedContacts,
  unwrapExternalCommercialLinks,
} from '../../src/modules/cms/blog/contact-block-cleaner';

/** 是否仍含第三方 B2B 平台外链（alibaba / alicdn） */
function hasExternalCommercialLinks(html: string): boolean {
  return /<a\b[^>]*href="https?:\/\/[^"]*(?:alibaba|alicdn)\.com[^"]*"/i.test(html);
}

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = /^DATABASE_URL=(.*)$/m.exec(raw);
  if (!m) throw new Error('.env 中未找到 DATABASE_URL');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function assertLocalDatabase(): void {
  const url = loadDatabaseUrl();
  const u = new URL(url);
  const host = u.hostname;
  const db = u.pathname.replace(/^\//, '');
  if (!['localhost', '127.0.0.1'].includes(host) || db.includes('_e2e')) {
    throw new Error(`拒绝执行：仅允许本地开发库（当前 host=${host} db=${db}）`);
  }
}

/** 纯文本长度（去标签、压空白）——用于内容骤减保护 */
function textLength(html: string): number {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

/** 保留率下限：清洗后纯文本不得低于原文的 60%（防止规则误伤整段） */
const MIN_RETENTION = 0.6;

/** 依次应用：联系方式 → 年限宣传语 → 第三方 B2B 外链解包 → sanitize */
function cleanHtml(input: string): { html: string; hits: string[] } {
  const step1 = stripHardcodedContacts(input);
  const step2 = stripExperienceClaims(step1.html);
  const step3 = unwrapExternalCommercialLinks(step2.html);
  const html = sanitizeRichText(step3.html);
  return {
    html,
    hits: [...step1.hits, ...step2.hits, ...(step3.hits ? [`external-anchor:${step3.hits}`] : [])],
  };
}

async function main(): Promise<void> {
  assertLocalDatabase();
  console.log(`模式：${APPLY ? 'APPLY（写库）' : 'DRY-RUN（不写库）'}\n`);

  const posts = await prisma.blogPost.findMany({
    select: { id: true, slug: true, content: true, excerpt: true },
    orderBy: { slug: 'asc' },
  });
  const products = await prisma.product.findMany({
    select: { id: true, slug: true, description: true },
    orderBy: { slug: 'asc' },
  });

  const postChanges: Array<Record<string, unknown>> = [];
  const productChanges: Array<Record<string, unknown>> = [];
  const postBackup: Array<Record<string, string>> = [];
  const productBackup: Array<Record<string, string>> = [];

  for (const post of posts) {
    const before = post.content ?? '';
    if (
      !hasHardcodedContacts(before) &&
      !hasExperienceClaims(before) &&
      !hasExternalCommercialLinks(before)
    ) {
      continue;
    }
    const { html, hits } = cleanHtml(before);
    if (html === before) continue;
    const retention = textLength(before) === 0 ? 1 : textLength(html) / textLength(before);
    if (retention < MIN_RETENTION) {
      postChanges.push({ slug: post.slug, hits, skipped: `retention=${retention.toFixed(2)}` });
      continue;
    }
    const excerptBefore = post.excerpt ?? '';
    const excerptAfter =
      hasHardcodedContacts(excerptBefore) || hasExperienceClaims(excerptBefore)
        ? cleanBlogExcerpt(excerptBefore, html)
        : excerptBefore;
    postChanges.push({
      slug: post.slug,
      hits,
      beforeLen: before.length,
      afterLen: html.length,
      excerptChanged: excerptAfter !== excerptBefore,
    });
    postBackup.push({ id: post.id, slug: post.slug, content: before, excerpt: excerptBefore });
    if (APPLY) {
      await prisma.blogPost.update({
        where: { id: post.id },
        data: { content: html, excerpt: excerptAfter },
      });
    }
  }

  for (const product of products) {
    const before = product.description ?? '';
    if (
      !hasHardcodedContacts(before) &&
      !hasExperienceClaims(before) &&
      !hasExternalCommercialLinks(before)
    ) {
      continue;
    }
    const { html, hits } = cleanHtml(before);
    if (html === before) continue;
    const retention = textLength(before) === 0 ? 1 : textLength(html) / textLength(before);
    if (retention < MIN_RETENTION) {
      productChanges.push({ slug: product.slug, hits, skipped: `retention=${retention.toFixed(2)}` });
      continue;
    }
    productChanges.push({ slug: product.slug, hits, beforeLen: before.length, afterLen: html.length });
    productBackup.push({ id: product.id, slug: product.slug, description: before });
    if (APPLY) {
      await prisma.product.update({ where: { id: product.id }, data: { description: html } });
    }
  }

  if (APPLY && (postBackup.length || productBackup.length)) {
    const dir = path.join(__dirname, '.backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (postBackup.length) {
      fs.writeFileSync(path.join(dir, `contacts-blog-${stamp}.json`), JSON.stringify(postBackup, null, 2));
    }
    if (productBackup.length) {
      fs.writeFileSync(
        path.join(dir, `contacts-products-${stamp}.json`),
        JSON.stringify(productBackup, null, 2),
      );
    }
    console.log(`备份已写入 prisma/scripts/.backups/（${postBackup.length} 篇文章 / ${productBackup.length} 个产品）\n`);
  }

  console.log(JSON.stringify({ posts: postChanges, products: productChanges }, null, 2));
  console.log(
    `\n合计：文章 ${postChanges.length} 篇、产品 ${productChanges.length} 个${APPLY ? ' 已写入' : ' 待清洗'}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
