/**
 * /uploads/media/ 坏链修复（2026-10-23 线上事故修复工具）
 *
 * 背景：生产库里大量图片地址形如
 *   https://bailingwooden.com/uploads/media/2026/10/<uuid>.<ext>
 * 这类地址在后端切换到 COS（Phase 6）后全部 404：
 *   · 文件在 COS 上的正确地址是 https://cdn.bailingwooden.com/media/...
 *   · 历史迁移脚本 migrate-media-to-cos.cjs 的 LOCAL_URL_RE 只匹配
 *     内网/localhost 主机，**生产域名的 /uploads 地址被故意跳过**，
 *     导致生产库这批引用从未被改写（其中一部分文件也从未上传到 COS）。
 *
 * 本脚本做三件事（默认 dry-run，`--apply` 才落库）：
 *   1. 扫描 7 个可能残留 `/uploads/media/` 地址的位置，收集全部 distinct URL
 *      （不限主机：生产域名 / 内网 / localhost 一律收集）
 *   2. 逐个 key 在 COS 上 headObject 验证对象是否存在
 *   3. **只把「COS 上确实存在」的 URL 改写为 CDN 地址**；文件已丢失的
 *      列进缺失清单（需要重新上传，改写无意义）
 *
 * 安全设计：
 *   · key 必须命中 media/<年>/<月>/<uuid>.<ext> 白名单，否则跳过并报告
 *   · COS 上不存在的对象绝不改写（避免把 404 从一个域名搬到另一个域名）
 *   · 改写用整 URL 精确 replace，不碰其它内容；可重复执行（幂等）
 *   · 不删除任何本地文件
 *
 * 用法（在 VPS 后端容器内执行，容器已带 DATABASE_URL；COS 验证走 CDN HEAD，
 * 只需 COS_CDN_DOMAIN，旧镜像无 cos SDK 也能跑）：
 *   docker cp prisma/scripts/repair-uploads-media-urls.cjs bailing-backend:/app/repair.cjs
 *   docker exec bailing-backend node /app/repair.cjs --env-file=/app/repair-cos.env            # 预演
 *   docker exec bailing-backend node /app/repair.cjs --env-file=/app/repair-cos.env --apply    # 执行
 * （repair-cos.env 为 dotenv 格式，至少含 COS_CDN_DOMAIN）
 * 执行后必须让前台失效缓存（见 runbook）：POST /api/revalidate。
 */
try {
  // 容器内无 dotenv（生产依赖之外），本地开发才有；取不到就算了
  require('dotenv').config({ quiet: true });
} catch {
  /* 容器内运行：环境变量由容器注入，无需 dotenv */
}

// 可选：--env-file=<path> 追加加载 dotenv 格式文件（不覆盖已有环境变量）。
// 用途：生产后端容器是 LOCAL 存储、没有 COS 凭据，需在容器内注入
// TENCENT_COS_* / COS_CDN_DOMAIN 才能执行 COS 侧验证。
const envFileArg = process.argv.find((a) => a.startsWith('--env-file='));
if (envFileArg) {
  const fs = require('node:fs');
  const envPath = envFileArg.slice('--env-file='.length);
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const CDN = (process.env.COS_CDN_DOMAIN || '').replace(/\/+$/, '');

if (!CDN) {
  console.error('缺少 COS_CDN_DOMAIN（CDN 域名，用于 HEAD 验证对象是否存在）');
  process.exit(1);
}

const prisma = new PrismaClient();

/** 绝对 URL 中含 /uploads/media/ 的统统抓出来（主机不限） */
const UPLOADS_MEDIA_URL_RE = /https?:\/\/[^\s"'<>\\)]*\/uploads\/media\/[^\s"'<>\\)]+/g;

/** storageKey 白名单：media/<4位年>/<2位月>/<uuid>.<ext> */
const STORAGE_KEY_PATTERN =
  /^media\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;

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

/** 去掉正文里 URL 尾部可能带入的标点（句号/逗号/括号等） */
function cleanUrl(raw) {
  return raw.replace(/[.,;:!?)\]}>'"`]+$/, '');
}

/** URL -> COS key；不合法返回 null */
function keyFromUrl(url) {
  const idx = url.indexOf('/uploads/');
  if (idx < 0) return null;
  const key = decodeURIComponent(url.slice(idx + '/uploads/'.length).split('?')[0].split('#')[0]);
  return STORAGE_KEY_PATTERN.test(key) ? key : null;
}

/**
 * 验证 COS 对象是否存在：对 CDN 域名发 HEAD（CDN 对私有桶已授权回源，
 * 对象存在 → 200，不存在 → 404）。
 *
 * 为什么不用 cos-nodejs-sdk-v5：生产后端容器跑的是 COS 改造前的旧镜像
 * （STORAGE_PROVIDER=LOCAL），node_modules 里没有该 SDK；CDN HEAD 与
 * SDK headObject 结论一致（已用两种方式交叉验证 139 个 key），且零依赖，
 * 任何 node 18+ 环境都能跑。
 */
const headOnCdn = async (key) => {
  try {
    const res = await fetch(`${CDN}/${key}`, { method: 'HEAD' });
    return res.status === 200;
  } catch {
    return false;
  }
};

(async () => {
  console.log(APPLY ? '=== 执行模式（会写库） ===' : '=== 预演模式（不写库） ===');
  console.log(`CDN: ${CDN}`);

  // ---------- 1. 收集所有 /uploads/media/ URL 及其出现位置 ----------
  // url -> Set(location)
  const refs = new Map();
  const addRef = (url, location) => {
    const u = cleanUrl(url);
    if (!refs.has(u)) refs.set(u, new Set());
    refs.get(u).add(location);
  };
  const collect = (text, location) => {
    if (!text) return;
    for (const m of String(text).matchAll(UPLOADS_MEDIA_URL_RE)) addRef(m[0], location);
  };

  const mediaRows = await prisma.$queryRawUnsafe(
    `select id, url from media_assets where url like '%/uploads/media/%'`,
  );
  mediaRows.forEach((r) => addRef(r.url, `media_assets#${r.id}`));

  const imageRows = await prisma.$queryRawUnsafe(
    `select id, url from product_images where url like '%/uploads/media/%'`,
  );
  imageRows.forEach((r) => addRef(r.url, `product_images#${r.id}`));

  const blogCover = await prisma.$queryRawUnsafe(
    `select id, "coverImageUrl" as u from blog_posts where "coverImageUrl" like '%/uploads/media/%'`,
  );
  blogCover.forEach((r) => addRef(r.u, `blog_posts.coverImageUrl#${r.id}`));

  const avatars = await prisma.$queryRawUnsafe(
    `select id, "avatarUrl" as u from employee_contacts where "avatarUrl" like '%/uploads/media/%'`,
  );
  avatars.forEach((r) => addRef(r.u, `employee_contacts.avatarUrl#${r.id}`));

  const prodDesc = await prisma.$queryRawUnsafe(
    `select id, description from products where description like '%/uploads/media/%'`,
  );
  prodDesc.forEach((r) => collect(r.description, `products.description#${r.id}`));

  const blogContent = await prisma.$queryRawUnsafe(
    `select id, content from blog_posts where content like '%/uploads/media/%'`,
  );
  blogContent.forEach((r) => collect(r.content, `blog_posts.content#${r.id}`));

  const revisions = await prisma.$queryRawUnsafe(
    `select id, snapshot::text as s from content_revisions where snapshot::text like '%/uploads/media/%'`,
  );
  revisions.forEach((r) => collect(r.s, `content_revisions.snapshot#${r.id}`));

  const totalRefs = [...refs.values()].reduce((n, s) => n + s.size, 0);
  console.log(`\n扫描到 distinct URL: ${refs.size}（引用 ${totalRefs} 处）`);
  if (refs.size === 0) {
    console.log('没有需要修复的地址。');
    await prisma.$disconnect();
    return;
  }

  // ---------- 2. 逐个 key 验证 COS 对象是否存在 ----------
  const mapping = new Map(); // oldUrl -> { key, newUrl }
  const missing = []; // { url, key|null, locations }
  const unrecognized = [];

  const urls = [...refs.keys()];
  let cursor = 0;
  const CONCURRENCY = 8;
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      const key = keyFromUrl(url);
      if (!key) {
        unrecognized.push({ url, locations: [...refs.get(url)] });
        continue;
      }
      if (await headOnCdn(key)) {
        mapping.set(url, { key, newUrl: `${CDN}/${key}` });
      } else {
        missing.push({ url, key, locations: [...refs.get(url)] });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nCOS 上存在（可改写）: ${mapping.size}`);
  console.log(`COS 上缺失（文件已丢，需重新上传）: ${missing.length}`);
  if (unrecognized.length) {
    console.log(`key 不在白名单（跳过）: ${unrecognized.length}`);
    unrecognized.slice(0, 10).forEach((m) => console.log(`  ${m.url}`));
  }

  if (mapping.size) {
    console.log('\n--- 可改写清单 ---');
    for (const [url, { newUrl }] of mapping) {
      const locs = [...refs.get(url)];
      console.log(`  ${url}\n    -> ${newUrl}`);
      locs.slice(0, 5).forEach((l) => console.log(`    @ ${l}`));
      if (locs.length > 5) console.log(`    @ ...等 ${locs.length} 处`);
    }
  }

  if (missing.length) {
    const byTable = {};
    for (const m of missing) {
      for (const l of m.locations) {
        const t = l.split('#')[0];
        byTable[t] = (byTable[t] || 0) + 1;
      }
    }
    console.log('\n缺失引用按表分布:', JSON.stringify(byTable));
  }

  if (missing.length) {
    console.log('\n--- 缺失文件清单（前 20 条）---');
    missing.slice(0, 20).forEach((m) => {
      console.log(`  ${m.key}`);
      m.locations.slice(0, 3).forEach((l) => console.log(`      @ ${l}`));
      if (m.locations.length > 3) console.log(`      @ ...等 ${m.locations.length} 处`);
    });
    if (missing.length > 20) console.log(`  ...共 ${missing.length} 条`);
  }

  if (!APPLY) {
    console.log('\n预演结束。确认无误后加 --apply 执行。');
    await prisma.$disconnect();
    return;
  }

  // ---------- 3. 回写数据库（与 migrate-media-to-cos.cjs 同一套 replace 语义） ----------
  let touched = 0;
  const errors = [];
  for (const [oldUrl, { key, newUrl }] of mapping) {
    try {
      // media_assets 同时纠正 storageKey / provider；若 storageKey 与既有行撞车
      // （同一对象已被另一行引用），降级为只改 url——URL 改写才是目的。
      try {
        await prisma.$executeRawUnsafe(
          `update media_assets set url = $1, "storageKey" = $2, provider = 'TENCENT_COS' where url = $3`,
          newUrl,
          key,
          oldUrl,
        );
      } catch (e) {
        if (e?.code === 'P2002' || `${e?.message}`.includes('already exists')) {
          await prisma.$executeRawUnsafe(
            `update media_assets set url = $1 where url = $2`,
            newUrl,
            oldUrl,
          );
        } else {
          throw e;
        }
      }
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
    } catch (e) {
      errors.push({ url: oldUrl, message: e?.message ?? String(e) });
    }
  }
  console.log(`\n已回写 ${touched} 个 URL 映射`);
  if (errors.length) {
    console.log(`失败 ${errors.length} 个（不影响其余映射）：`);
    errors.slice(0, 10).forEach((e) => console.log(`  ${e.url} -> ${e.message}`));
  }

  // ---------- 4. 复核 ----------
  const left = await prisma.$queryRawUnsafe(`
    select
      (select count(*) from media_assets where url like '%/uploads/media/%')::int as media_left,
      (select count(*) from product_images where url like '%/uploads/media/%')::int as product_left,
      (select count(*) from blog_posts where "coverImageUrl" like '%/uploads/media/%')::int as blog_cover_left,
      (select count(*) from employee_contacts where "avatarUrl" like '%/uploads/media/%')::int as avatar_left,
      (select count(*) from products where description like '%/uploads/media/%')::int as product_desc_left,
      (select count(*) from blog_posts where content like '%/uploads/media/%')::int as blog_content_left,
      (select count(*) from content_revisions where snapshot::text like '%/uploads/media/%')::int as revisions_left
  `);
  console.log('残留检查:', JSON.stringify(left[0]));
  console.log(
    '\n注意：残留即「文件已丢失」部分，需要重新上传图片并更新内容；' +
      '随后必须调用前台 POST /api/revalidate 刷新 ISR 缓存。',
  );

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FATAL', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
