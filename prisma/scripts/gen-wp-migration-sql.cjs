/**
 * 由 mapping.json 生成数据库回写 SQL（本地/生产通用）。
 *
 * 产出两类语句：
 *   1. UPDATE blog_posts.content / products.description：replace(旧URL, 新CDN URL)
 *      —— 旧URL 用库中原始存储形态（含 &amp; 实体）精确匹配
 *   2. INSERT media_assets：登记到媒体库（storageKey 唯一约束 + NOT EXISTS 双重幂等）
 *
 * 用法：node gen-wp-migration-sql.js <mapping.json> <blogs.txt> <products.txt> <out.sql>
 */
const fs = require('fs');
const crypto = require('crypto');

const [mappingPath, blogsPath, productsPath, outPath] = process.argv.slice(2);
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
const blogs = fs.readFileSync(blogsPath, 'utf8');
const products = fs.readFileSync(productsPath, 'utf8');

const esc = (s) => s.replace(/'/g, "''");

const lines = [];
lines.push('-- i0.wp.com 外链图片 → COS 回写（由 gen-wp-migration-sql.js 生成，勿手改）');
lines.push('BEGIN;');
lines.push('');

for (const [oldUrl, info] of Object.entries(mapping)) {
  const usage = products.includes(oldUrl) ? 'PRODUCT' : blogs.includes(oldUrl) ? 'BLOG' : 'OTHER';
  const id = 'cm' + crypto.createHash('sha1').update(info.key).digest('hex').slice(0, 22);
  const filename = info.key.split('/').pop();

  lines.push(`-- ${info.originalName} → ${info.key} (${usage})`);
  lines.push(
    `UPDATE blog_posts SET content = replace(content, $wp$${oldUrl}$wp$, $wp$${info.newUrl}$wp$) WHERE content LIKE '%' || $wp$${oldUrl}$wp$ || '%';`,
  );
  lines.push(
    `UPDATE products SET description = replace(description, $wp$${oldUrl}$wp$, $wp$${info.newUrl}$wp$) WHERE description LIKE '%' || $wp$${oldUrl}$wp$ || '%';`,
  );
  lines.push(`INSERT INTO media_assets (id, filename, "storageKey", url, "mimeType", size, provider, "createdAt", "updatedAt", "originalName", category, "createdBy", usage)`);
  lines.push(`SELECT '${id}', '${esc(filename)}', '${esc(info.key)}', '${esc(info.newUrl)}', '${esc(info.mimeType)}', ${info.size}, 'TENCENT_COS', now(), now(), '${esc(info.originalName)}', 'IMAGE', (SELECT id FROM admin_users ORDER BY "createdAt" ASC LIMIT 1), '${usage}'`);
  lines.push(`WHERE NOT EXISTS (SELECT 1 FROM media_assets WHERE "storageKey" = '${esc(info.key)}');`);
  lines.push('');
}

lines.push('COMMIT;');
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`已生成 ${outPath}（${Object.keys(mapping).length} 组映射）`);
