/**
 * 阶段 3 验证：CMS 重存往返（read-only，不写库）
 *
 * 目的：证明经 Phase 2 清洗入库的 content，再次经过 sanitizeRichText
 * （CMS 保存路径）时输出与输入完全一致 —— 即编辑保存不会损坏受控结构
 * （prose-boxed-heading / prose-table-scroll / 表格嵌套 / 链接 / 图片）。
 *
 * 取数方式：docker exec psql 只读导出 JSON，不在 Node 侧引入 Prisma。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeRichText } = require('../../dist/modules/cms/blog/rich-text.sanitizer.js');

const raw = execFileSync('docker', [
  'exec', '-i', 'bailing-postgres', 'psql',
  '-U', 'bailing', '-d', 'bailingwooden',
  '-t', '-A',
  '-c',
  `SELECT json_agg(ROW_TO_JSON(t)) FROM (SELECT id, slug, content FROM blog_posts WHERE status = 'PUBLISHED' ORDER BY "createdAt") t`,
]).toString('utf8');
const rows = JSON.parse(raw);

let ok = 0;
const failures = [];
for (const row of rows) {
  const { id, slug, content } = row;
  const out = sanitizeRichText(content);
  if (out === content) {
    ok += 1;
  } else {
    // 找出首个差异位置，便于诊断
    let i = 0;
    while (i < Math.min(out.length, content.length) && out[i] === content[i]) i += 1;
    failures.push({
      id,
      slug,
      inLen: content.length,
      outLen: out.length,
      firstDiffAt: i,
      inCtx: content.slice(Math.max(0, i - 40), i + 40).replace(/\n/g, '\\n'),
      outCtx: out.slice(Math.max(0, i - 40), i + 40).replace(/\n/g, '\\n'),
    });
  }
}

console.log(JSON.stringify({ total: rows.length, identical: ok, changed: failures.length, failures }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
