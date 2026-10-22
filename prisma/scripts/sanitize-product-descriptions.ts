/**
 * 回填脚本：清洗存量产品描述（Phase 5.4.x 迁移遗留的裸 HTML）。
 *
 * 背景：
 *   Phase 5.4.3b 从旧 WordPress 站点迁移产品时，description 字段保留了源站
 *   的整段 HTML（含 <div class="module_attribute" data-module-name="..."> 等
 *   与产品无关的属性）。Phase 5.5 在 ProductsService.create/update 写入端
 *   接入了 sanitizeRichText，但已入库的历史数据未自动迁移——前台详情页
 *   会按文本渲染整段 HTML。
 *
 * 本脚本：
 *   1. 默认 DRY-RUN：仅打印每条 description 清洗前后长度差异
 *   2. --apply：把 sanitizeRichText 结果写回 DB
 *   3. 幂等：相同输入跑两次第二次无差异
 *   4. 写入后抽样打印前 200 字符，便于人工核对
 *
 * 用法：
 *   npx ts-node prisma/scripts/sanitize-product-descriptions.ts            # dry-run
 *   npx ts-node prisma/scripts/sanitize-product-descriptions.ts --apply    # 写入
 *
 * 注意：
 *   须指向主库 DATABASE_URL（不是 e2e 库）。脚本不做事务——逐条 update，
 *   即便中途失败也不会破坏一致性（已清洗的行无变化、未清洗的行保持原样）。
 */
import { PrismaClient } from '@prisma/client';
import { sanitizeRichText } from '../../src/modules/cms/blog/rich-text.sanitizer';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  const products = await prisma.product.findMany({
    select: { id: true, slug: true, name: true, description: true },
  });

  const changed: Array<{
    id: string;
    slug: string;
    name: string;
    beforeLen: number;
    afterLen: number;
    preview: string;
  }> = [];
  const unchanged: Array<{ id: string; slug: string }> = [];

  for (const p of products) {
    const cleaned = sanitizeRichText(p.description);
    if (cleaned === p.description) {
      unchanged.push({ id: p.id, slug: p.slug });
      continue;
    }
    changed.push({
      id: p.id,
      slug: p.slug,
      name: p.name,
      beforeLen: p.description.length,
      afterLen: cleaned.length,
      preview: cleaned.slice(0, 200),
    });
  }

  console.log(`\n[products total]    ${products.length}`);
  console.log(`[unchanged]         ${unchanged.length}`);
  console.log(`[to be sanitized]   ${changed.length}`);

  if (changed.length === 0) {
    console.log('\n无需清洗。');
    return;
  }

  console.log('\n— 需要清洗的产品（前 10 条） —');
  for (const c of changed.slice(0, 10)) {
    console.log(`  · ${c.slug}  (${c.beforeLen} -> ${c.afterLen} chars)`);
    console.log(`    preview: ${c.preview}…`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN 模式，未写入。如需落库：--apply');
    return;
  }

  console.log('\n— 写入中 —');
  let written = 0;
  for (const c of changed) {
    const cleaned = sanitizeRichText(
      (await prisma.product.findUnique({ where: { id: c.id }, select: { description: true } }))!
        .description,
    );
    await prisma.product.update({ where: { id: c.id }, data: { description: cleaned } });
    written += 1;
  }
  console.log(`[written]           ${written}`);
  console.log('\n完成。可重跑本脚本验证幂等：第二次应输出 [to be sanitized] 0');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
