/**
 * 回填脚本：把超长的产品简短描述收敛到 100 字以内。
 *
 * 背景：
 *   Phase 5.4.3b 迁移旧站时 shortDescription 直接取了旧站 description 的前
 *   300 字符，导致前台产品卡片被撑到 1000+px 高（标题/标签之下像一堵墙）。
 *   Phase 5.5 把 shortDescription 上限收紧为 100 字（与后台表单一致），
 *   旧的超长行需要在编辑前先收敛，否则后台保存会被后端 400 拒绝。
 *
 * 截断策略（优先保住语义完整，不是硬切）：
 *   1. 在 ≤100 字范围内找最后一个句末标点（。.!?！？）后的空白，切在句子边界
 *   2. 否则找最后一个中文标点（，,、；;）后的空白
 *   3. 否则找最后一个空格
 *   4. 都不满足才硬切 100 字
 *   切掉后半段文本后不再补省略号（SEO meta 与卡片上更干净）
 *
 * 用法：
 *   npx ts-node prisma/scripts/truncate-product-short-descriptions.ts            # dry-run
 *   npx ts-node prisma/scripts/truncate-product-short-descriptions.ts --apply    # 写入
 *
 * 幂等：第二次运行输出 0 行待处理。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const MAX = 100;

/** 尾部子句标点（切在逗号/分号上时去掉，避免尾巴像没写完） */
const TRAILING_CLAUSE_PUNCT = /[\s,，、;；:：]+$/;

/** 在 <= MAX 范围内找最佳切分点：句子 > 子句 > 空格 > 硬切 */
function smartTruncate(input: string): string {
  const text = input.trim();
  if (text.length <= MAX) return text;

  const window = text.slice(0, MAX);

  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
  );
  if (sentenceEnd >= MAX * 0.5) {
    // 句号本身保留，去掉其后空白
    const cut = sentenceEnd + 1;
    return text.slice(0, cut).trim();
  }

  const clauseEnd = Math.max(
    window.lastIndexOf(','),
    window.lastIndexOf('，'),
    window.lastIndexOf('、'),
    window.lastIndexOf(';'),
    window.lastIndexOf('；'),
    window.lastIndexOf(':'),
    window.lastIndexOf('：'),
  );
  if (clauseEnd >= MAX * 0.5) {
    // 子句切分：剥掉尾部标点，读起来像一句话自然收住
    return text.slice(0, clauseEnd + 1).replace(TRAILING_CLAUSE_PUNCT, '');
  }

  const space = window.lastIndexOf(' ');
  if (space >= MAX * 0.6) {
    return text.slice(0, space).trim();
  }

  return text.slice(0, MAX).trim();
}

async function main() {
  const products = await prisma.product.findMany({
    select: { id: true, slug: true, name: true, shortDescription: true },
    orderBy: { updatedAt: 'desc' },
  });

  const toTrim: Array<{
    id: string;
    slug: string;
    beforeLen: number;
    afterLen: number;
    preview: string;
  }> = [];

  for (const p of products) {
    if (!p.shortDescription || p.shortDescription.length <= MAX) continue;
    const shortened = smartTruncate(p.shortDescription);
    toTrim.push({
      id: p.id,
      slug: p.slug,
      beforeLen: p.shortDescription.length,
      afterLen: shortened.length,
      preview: shortened,
    });
  }

  console.log(`\n[products total]      ${products.length}`);
  console.log(`[to truncate >100]    ${toTrim.length}`);

  if (toTrim.length === 0) {
    console.log('\n无需处理。');
    return;
  }

  console.log('\n— 待截断（前 8 条预览）—');
  for (const t of toTrim.slice(0, 8)) {
    console.log(`  · ${t.slug}  (${t.beforeLen} -> ${t.afterLen})`);
    console.log(`    ${t.preview}`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN 模式，未写入。如需落库：--apply');
    return;
  }

  let written = 0;
  for (const t of toTrim) {
    await prisma.product.update({
      where: { id: t.id },
      data: { shortDescription: t.preview },
    });
    written += 1;
  }
  console.log(`\n[written]            ${written}`);

  // 自校：DB 中不应再有超过 MAX 的行
  const remaining = await prisma.product.count({
    where: { shortDescription: { not: null } },
  });
  const stillLong = await prisma.product.findMany({
    where: { shortDescription: { not: null } },
    select: { id: true, shortDescription: true },
  });
  const over = stillLong.filter((r) => (r.shortDescription ?? '').length > MAX);
  console.log(`[self-check]         ${remaining} rows, ${over.length} still > ${MAX}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
