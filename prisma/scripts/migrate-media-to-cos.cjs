/**
 * 本地媒体 → 腾讯云 COS 迁移（Phase 6.2）
 *
 * 背景：历史媒体文件存在后端本地磁盘，数据库里存的是
 *   http://192.168.1.40:4000/uploads/media/2026/10/xxx.webp
 * 这类地址在换网络、走隧道、对外访问时全部失效；且富文本正文里也硬编码了同样的地址。
 *
 * 本脚本做三件事（默认 dry-run，`--apply` 才落库）：
 *   1. 扫描 7 个可能存放内网图片地址的位置，收集全部 distinct URL
 *   2. 按 URL 路径在本地 uploads/ 找到文件 → 上传到 COS（key 与既有 storageKey 同构）
 *   3. 把库里所有引用整体替换成 CDN 地址（媒体表同时更新 provider / storageKey）
 *
 * 安全设计：
 *   · 只处理「本机内网/localhost 的 /uploads/ 地址」，其它域名一律不动
 *   · COS 对象已存在则跳过（可重复执行，幂等）
 *   · 本地文件缺失只报告不中断，最后统一列出
 *   · 不删除本地文件，随时可回滚
 *
 * 用法：
 *   node prisma/scripts/migrate-media-to-cos.cjs            # 预演
 *   node prisma/scripts/migrate-media-to-cos.cjs --apply    # 执行
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const CDN = (process.env.COS_CDN_DOMAIN || '').replace(/\/$/, '');
const BUCKET = process.env.TENCENT_COS_BUCKET;
const REGION = process.env.TENCENT_COS_REGION;

if (!CDN || !BUCKET || !REGION) {
  console.error('缺少 COS_CDN_DOMAIN / TENCENT_COS_BUCKET / TENCENT_COS_REGION');
  process.exit(1);
}

const prisma = new PrismaClient();
const cos = new COS({
  SecretId: process.env.TENCENT_COS_SECRET_ID,
  SecretKey: process.env.TENCENT_COS_SECRET_KEY,
});

/** 只匹配本机内网 / localhost 的 uploads 地址 */
const LOCAL_URL_RE = /https?:\/\/(?:192\.168\.\d+\.\d+|localhost|127\.0\.0\.1)(?::\d+)?\/uploads\/[^\s"'<>\\)]+/g;

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

const putObject = (params) =>
  new Promise((resolve, reject) => cos.putObject(params, (err, data) => (err ? reject(err) : resolve(data))));
const headObject = (Key) =>
  new Promise((resolve) => cos.headObject({ Bucket: BUCKET, Region: REGION, Key }, (err) => resolve(!err)));

/** 从 URL 推导 COS key：/uploads/media/2026/10/x.webp -> media/2026/10/x.webp */
function keyFromUrl(url) {
  const idx = url.indexOf('/uploads/');
  if (idx < 0) return null;
  const key = decodeURIComponent(url.slice(idx + '/uploads/'.length).split('?')[0]);
  if (!/^(media|products)\/\d{4}\/\d{2}\/[A-Za-z0-9._-]+$/.test(key) && !/^media\/[A-Za-z0-9._/-]+$/.test(key)) {
    return null;
  }
  return key;
}

(async () => {
  console.log(APPLY ? '=== 执行模式（会写库） ===' : '=== 预演模式（不写库） ===');

  // ---------- 1. 收集所有内网 URL ----------
  const urls = new Set();
  const collect = (text) => {
    if (!text) return;
    for (const m of String(text).matchAll(LOCAL_URL_RE)) urls.add(m[0]);
  };

  const mediaRows = await prisma.$queryRawUnsafe(
    `select id, url from media_assets where url like '%/uploads/%'`,
  );
  mediaRows.forEach((r) => collect(r.url));

  const imageRows = await prisma.$queryRawUnsafe(
    `select id, url from product_images where url like '%/uploads/%'`,
  );
  imageRows.forEach((r) => collect(r.url));

  const blogCover = await prisma.$queryRawUnsafe(
    `select id, "coverImageUrl" as u from blog_posts where "coverImageUrl" like '%/uploads/%'`,
  );
  blogCover.forEach((r) => collect(r.u));

  const avatars = await prisma.$queryRawUnsafe(
    `select id, "avatarUrl" as u from employee_contacts where "avatarUrl" like '%/uploads/%'`,
  );
  avatars.forEach((r) => collect(r.u));

  const prodDesc = await prisma.$queryRawUnsafe(
    `select id, description from products where description like '%/uploads/%'`,
  );
  prodDesc.forEach((r) => collect(r.description));

  const blogContent = await prisma.$queryRawUnsafe(
    `select id, content from blog_posts where content like '%/uploads/%'`,
  );
  blogContent.forEach((r) => collect(r.content));

  const revisions = await prisma.$queryRawUnsafe(
    `select id, snapshot::text as s from content_revisions where snapshot::text like '%/uploads/%'`,
  );
  revisions.forEach((r) => collect(r.s));

  console.log(`扫描到 distinct 内网 URL: ${urls.size}`);

  // ---------- 2. 上传 ----------
  const mapping = new Map();
  const missing = [];
  let uploaded = 0;
  let skipped = 0;

  // 先把 URL → 本地文件 的映射全部建好（纯本地判断，快）
  const candidates = [];
  for (const url of [...urls]) {
    const key = keyFromUrl(url);
    if (!key) {
      missing.push({ url, reason: 'URL 结构无法识别' });
      continue;
    }
    const diskPath = path.join(process.cwd(), 'uploads', key);
    if (!fs.existsSync(diskPath)) {
      missing.push({ url, reason: `本地文件缺失: uploads/${key}` });
      continue;
    }
    const newUrl = `${CDN}/${key}`;
    mapping.set(url, { key, newUrl, diskPath });
    candidates.push({ url, key, newUrl, diskPath });
  }

  // 并发 8 处理，避免逐个往返把 300 个对象拖成几分钟
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const item = candidates[cursor++];
      if (await headObject(item.key)) {
        skipped += 1;
        continue;
      }
      if (APPLY) {
        const buffer = fs.readFileSync(item.diskPath);
        const ext = path.extname(item.key).toLowerCase();
        await putObject({
          Bucket: BUCKET,
          Region: REGION,
          Key: item.key,
          Body: buffer,
          ContentType: MIME[ext] ?? 'application/octet-stream',
          CacheControl: 'public, max-age=604800',
        });
      }
      uploaded += 1;
      if ((uploaded + skipped) % 25 === 0) {
        console.log(`  进度 ${uploaded + skipped}/${candidates.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`可迁移: ${mapping.size}  待上传: ${uploaded}  已存在跳过: ${skipped}  无法处理: ${missing.length}`);
  if (missing.length) {
    console.log('--- 无法处理的条目（前 10 条）---');
    missing.slice(0, 10).forEach((m) => console.log(`  ${m.reason}  ${m.url}`));
  }

  if (!APPLY) {
    console.log('\n预演结束。确认无误后加 --apply 执行。');
    await prisma.$disconnect();
    return;
  }

  // ---------- 3. 回写数据库 ----------
  let touched = 0;
  for (const [oldUrl, { key, newUrl }] of mapping) {
    await prisma.$executeRawUnsafe(
      `update media_assets set url = $1, "storageKey" = $2, provider = 'TENCENT_COS' where url = $3`,
      newUrl,
      key,
      oldUrl,
    );
    await prisma.$executeRawUnsafe(`update product_images set url = $1 where url = $2`, newUrl, oldUrl);
    await prisma.$executeRawUnsafe(
      `update blog_posts set "coverImageUrl" = $1 where "coverImageUrl" = $2`,
      newUrl,
      oldUrl,
    );
    await prisma.$executeRawUnsafe(
      `update employee_contacts set "avatarUrl" = $1 where "avatarUrl" = $2`,
      newUrl,
      oldUrl,
    );
    await prisma.$executeRawUnsafe(
      `update products set description = replace(description, $1, $2) where description like '%' || $1 || '%'`,
      oldUrl,
      newUrl,
    );
    await prisma.$executeRawUnsafe(
      `update blog_posts set content = replace(content, $1, $2) where content like '%' || $1 || '%'`,
      oldUrl,
      newUrl,
    );
    await prisma.$executeRawUnsafe(
      `update content_revisions set snapshot = replace(snapshot::text, $1, $2)::jsonb where snapshot::text like '%' || $1 || '%'`,
      oldUrl,
      newUrl,
    );
    touched += 1;
  }
  console.log(`已回写 ${touched} 个 URL 映射`);

  // ---------- 4. 复核 ----------
  // count(*) 在 pg 里是 bigint，Prisma 会原样返回 BigInt —— 直接 JSON.stringify
  // 会抛 "Do not know how to serialize a BigInt"，这里显式 ::int 强转后再输出。
  const left = await prisma.$queryRawUnsafe(`
    select
      (select count(*) from media_assets where url like '%/uploads/%')::int as media_left,
      (select count(*) from product_images where url like '%/uploads/%')::int as product_left,
      (select count(*) from blog_posts where "coverImageUrl" like '%/uploads/%')::int as blog_cover_left,
      (select count(*) from employee_contacts where "avatarUrl" like '%/uploads/%')::int as avatar_left,
      (select count(*) from products where description like '%/uploads/%')::int as product_desc_left,
      (select count(*) from blog_posts where content like '%/uploads/%')::int as blog_content_left
  `);
  console.log('残留检查:', JSON.stringify(left[0]));

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FATAL', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
