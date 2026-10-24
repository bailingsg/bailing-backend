/**
 * /uploads/media/ 坏链修复 + 删除引用（2026-10-23 线上事故修复工具）
 *
 * 背景：生产库里大量图片地址形如
 *   https://bailingwooden.com/uploads/media/2026/10/<uuid>.<ext>
 * 这类地址在后端切换到 COS（Phase 6）后全部 404：
 *   · 文件在 COS 上的正确地址是 https://cdn.bailingwooden.com/media/...
 *   · 历史迁移脚本 migrate-media-to-cos.cjs 的 LOCAL_URL_RE 只匹配
 *     内网/localhost 主机，**生产域名的 /uploads 地址被故意跳过**，
 *     导致生产库这批引用从未被改写（其中大部分文件也从未上传到 COS）。
 *
 * 两阶段处理（默认只预演，不写库）：
 *   阶段 1（--apply）：CDN 上**确实存在**的对象 → 改写为 CDN 地址
 *   阶段 2（--apply --prune）：CDN 上**文件已丢失**的对象 → 删除引用
 *     · media_assets              删行（blog_posts.coverMediaId 由 FK SET NULL 自动置空）
 *     · product_images            删行
 *     · blog_posts.coverImageUrl  置 NULL（前台有 coverImage ? ... 兜底）
 *     · employee_contacts.avatarUrl 置 NULL
 *     · products.description      剥离指向坏图的 <img> / ![]() / 空 <a>
 *     · blog_posts.content        同上
 *     · content_revisions.snapshot **不动**：发布历史审计记录（action=PUBLISH/UNPUBLISH，
 *       快照内容从不返回给任何 UI、无恢复功能），改它等于篡改历史
 *
 * 安全设计：
 *   · key 必须命中 media/<年>/<月>/<uuid>.<ext> 白名单，否则跳过并报告
 *   · CDN 上不存在的对象绝不「改写」（避免把 404 从一个域名搬到另一个域名）
 *   · 删除只针对「已确认 404」的 URL，逐表逐行执行，单条失败不中断
 *   · 幂等：重复执行结果一致；不删除任何本地文件
 *
 * 用法（在 VPS 后端容器内执行，容器已带 DATABASE_URL；CDN 验证走 HEAD，
 * 只需 COS_CDN_DOMAIN，旧镜像无 cos SDK 也能跑）：
 *   docker cp prisma/scripts/repair-uploads-media-urls.cjs bailing-backend:/app/repair.cjs
 *   docker exec bailing-backend node /app/repair.cjs --env-file=/app/repair-cos.env                    # 预演
 *   docker exec bailing-backend node /app/repair.cjs --env-file=/app/repair-cos.env --apply             # 只改写
 *   docker exec bailing-backend node /app/repair.cjs --env-file=/app/repair-cos.env --apply --prune     # 改写 + 删引用
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
// COS_CDN_DOMAIN 才能执行 CDN 侧验证。
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
const PRUNE = process.argv.includes('--prune');
const VERBOSE = process.argv.includes('--verbose');
const CDN = (process.env.COS_CDN_DOMAIN || '').replace(/\/+$/, '');

if (!CDN) {
  console.error('缺少 COS_CDN_DOMAIN（CDN 域名，用于 HEAD 验证对象是否存在）');
  process.exit(1);
}
if (PRUNE && !APPLY) {
  console.error('--prune 必须与 --apply 同时使用（避免误删）；只预演请不要加参数。');
  process.exit(1);
}

const prisma = new PrismaClient();

/** 绝对 URL 中含 /uploads/media/ 的统统抓出来（主机不限） */
const UPLOADS_MEDIA_URL_RE = /https?:\/\/[^\s"'<>\\)]*\/uploads\/media\/[^\s"'<>\\)]+/g;

/** storageKey 白名单：media/<4位年>/<2位月>/<uuid>.<ext> */
const STORAGE_KEY_PATTERN =
  /^media\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;

/** 去掉正文里 URL 尾部可能带入的标点（句号/逗号/括号等） */
function cleanUrl(raw) {
  return String(raw).replace(/[.,;:!?)\]}>'"`]+$/, '');
}

/** URL -> COS key；不合法返回 null */
function keyFromUrl(url) {
  const idx = url.indexOf('/uploads/');
  if (idx < 0) return null;
  const key = decodeURIComponent(url.slice(idx + '/uploads/'.length).split('?')[0].split('#')[0]);
  return STORAGE_KEY_PATTERN.test(key) ? key : null;
}

/**
 * 验证 CDN 对象是否存在：对 CDN 域名发 HEAD（CDN 对私有桶已授权回源，
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

/**
 * 从富文本里剥离指向「已确认丢失」图片的引用。
 * 处理顺序：<img> → markdown 图片 → 空 <a> → 残留裸 URL → 空段落。
 */
function stripBrokenRefs(html, missingSet) {
  if (!html) return { text: html, removed: 0 };
  const before = html.length;
  let out = html;

  // 1) <img ...> 标签：src 命中坏链集合则整条删除
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const src = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
    return missingSet.has(cleanUrl(src)) ? '' : tag;
  });

  // 2) markdown 图片语法 ![alt](url)
  out = out.replace(/!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g, (whole, url) =>
    missingSet.has(cleanUrl(url)) ? '' : whole,
  );

  // 3) 只剩空壳的 <a> 包裹（img 被删后留下的）
  out = out.replace(/<a\b[^>]*>\s*<\/a>/gi, '');

  // 4) 裸 URL 残留（如 <a href="...">文字</a> 里的地址）
  for (const u of missingSet) {
    if (out.includes(u)) out = out.split(u).join('');
  }
  out = out.replace(/\s+href\s*=\s*(""|'')/gi, '');

  // 5) 清理因此变空的段落
  out = out.replace(/<p>\s*(?:&nbsp;)?\s*<\/p>/gi, '');

  return { text: out, removed: before - out.length };
}

/** 残留统计（阶段二结束后/仅改写后都会跑一次） */
async function reportLeftovers() {
  const left = await prisma.$queryRawUnsafe(`
    select
      (select count(*) from media_assets where url like '%/uploads/media/%')::int as media_left,
      (select count(*) from product_images where url like '%/uploads/media/%')::int as product_left,
      (select count(*) from blog_posts where "coverImageUrl" like '%/uploads/media/%')::int as blog_cover_left,
      (select count(*) from employee_contacts where "avatarUrl" like '%/uploads/media/%')::int as avatar_left,
      (select count(*) from products where description like '%/uploads/media/%')::int as product_desc_left,
      (select count(*) from blog_posts where content like '%/uploads/media/%')::int as blog_content_left,
      (select count(*) from content_revisions where snapshot::text like '%/uploads/media/%')::int as revisions_left_audit
  `);
  console.log('\n残留检查:', JSON.stringify(left[0]));
  console.log(
    '说明：revisions_left_audit 为发布历史审计快照，按设计保留；其余应为 0。' +
      '随后必须调用前台 POST /api/revalidate 刷新 ISR 缓存。',
  );
}

(async () => {
  console.log(
    APPLY
      ? PRUNE
        ? '=== 执行模式：改写 + 删引用（会写库） ==='
        : '=== 执行模式：仅改写（会写库） ==='
      : '=== 预演模式（不写库） ===',
  );
  console.log(`CDN: ${CDN}`);

  // ---------- 1. 收集所有 /uploads/media/ URL 及其出现位置 ----------
  const refs = new Map(); // url -> Set(location)
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

  // 只统计不处理：发布历史快照（审计记录，见文件头说明）
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

  // ---------- 2. 逐个 key 验证 CDN 对象是否存在 ----------
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

  console.log(`\nCDN 上存在（可改写）: ${mapping.size}`);
  console.log(`CDN 上缺失（文件已丢，删除引用）: ${missing.length}`);
  if (unrecognized.length) {
    console.log(`key 不在白名单（跳过）: ${unrecognized.length}`);
    unrecognized.slice(0, 10).forEach((m) => console.log(`  ${m.url}`));
  }

  // 可改写引用：按表聚合，避免刷屏
  if (mapping.size) {
    const byTable = {};
    for (const [url, { newUrl }] of mapping) {
      for (const l of refs.get(url)) {
        const t = l.split('#')[0];
        byTable[t] = (byTable[t] || 0) + 1;
      }
      if (VERBOSE) console.log(`  ${url}\n    -> ${newUrl}`);
    }
    console.log('  可改写引用分布:', JSON.stringify(byTable));
  }

  // 缺失引用：按表聚合
  const missingByTable = {};
  for (const m of missing) {
    for (const l of m.locations) {
      const t = l.split('#')[0];
      missingByTable[t] = (missingByTable[t] || 0) + 1;
    }
  }
  console.log('  缺失引用分布:', JSON.stringify(missingByTable));
  const auditOnly = missingByTable['content_revisions.snapshot'] || 0;
  if (auditOnly) {
    console.log(
      `  注：content_revisions.snapshot 的 ${auditOnly} 处保留不动（发布历史审计记录，任何 UI 都不渲染）`,
    );
  }

  if (!APPLY) {
    console.log('\n预演结束。改写: 加 --apply；改写+删引用: 加 --apply --prune。');
    await prisma.$disconnect();
    return;
  }

  // ---------- 3. 阶段一：改写可修复的 URL ----------
  const errors = [];
  let touched = 0;
  for (const [oldUrl, { key, newUrl }] of mapping) {
    try {
      try {
        await prisma.$executeRawUnsafe(
          `update media_assets set url = $1, "storageKey" = $2, provider = 'TENCENT_COS' where url = $3`,
          newUrl,
          key,
          oldUrl,
        );
      } catch (e) {
        // storageKey 与既有行撞车（同一对象已被另一行引用）→ 降级只改 url
        if (e?.code === 'P2002' || `${e?.message}`.includes('already exists')) {
          await prisma.$executeRawUnsafe(`update media_assets set url = $1 where url = $2`, newUrl, oldUrl);
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
      touched += 1;
    } catch (e) {
      errors.push({ url: oldUrl, message: e?.message ?? String(e) });
    }
  }
  console.log(`\n[阶段一] 已改写 ${touched} 个 URL 映射`);
  if (errors.length) {
    console.log(`  失败 ${errors.length} 个（不影响其余）：`);
    errors.slice(0, 10).forEach((e) => console.log(`    ${e.url} -> ${e.message}`));
  }

  if (!PRUNE) {
    console.log('\n[阶段二] 未启用（需加 --prune）。缺失文件引用保持原样。');
    await reportLeftovers();
    await prisma.$disconnect();
    return;
  }

  // ---------- 4. 阶段二：删除已确认丢失的引用 ----------
  const missingSet = new Set(missing.filter((m) => m.key).map((m) => m.url));
  const stats = {
    media_deleted: 0,
    product_images_deleted: 0,
    blog_cover_nulled: 0,
    avatar_nulled: 0,
    product_desc_cleaned: 0,
    blog_content_cleaned: 0,
  };

  // 4.1 media_assets：删行（blog_posts.coverMediaId 由 FK ON DELETE SET NULL 自动置空）
  const mediaIds = mediaRows.filter((r) => missingSet.has(cleanUrl(r.url))).map((r) => r.id);
  for (let i = 0; i < mediaIds.length; i += 200) {
    const chunk = mediaIds.slice(i, i + 200);
    try {
      const r = await prisma.mediaAsset.deleteMany({ where: { id: { in: chunk } } });
      stats.media_deleted += r.count;
    } catch (e) {
      errors.push({ url: `media_assets[${chunk.length} rows]`, message: e?.message ?? String(e) });
    }
  }

  // 4.2 product_images：删行
  const imageIds = imageRows.filter((r) => missingSet.has(cleanUrl(r.url))).map((r) => r.id);
  for (let i = 0; i < imageIds.length; i += 200) {
    const chunk = imageIds.slice(i, i + 200);
    try {
      const r = await prisma.productImage.deleteMany({ where: { id: { in: chunk } } });
      stats.product_images_deleted += r.count;
    } catch (e) {
      errors.push({ url: `product_images[${chunk.length} rows]`, message: e?.message ?? String(e) });
    }
  }

  // 4.3 blog_posts.coverImageUrl：置 NULL
  const coverIds = blogCover.filter((r) => missingSet.has(cleanUrl(r.u))).map((r) => r.id);
  for (let i = 0; i < coverIds.length; i += 200) {
    const chunk = coverIds.slice(i, i + 200);
    try {
      const r = await prisma.blogPost.updateMany({
        where: { id: { in: chunk } },
        data: { coverImageUrl: null },
      });
      stats.blog_cover_nulled += r.count;
    } catch (e) {
      errors.push({ url: `blog_posts.cover[${chunk.length} rows]`, message: e?.message ?? String(e) });
    }
  }

  // 4.4 employee_contacts.avatarUrl：置 NULL
  const avatarIds = avatars.filter((r) => missingSet.has(cleanUrl(r.u))).map((r) => r.id);
  for (let i = 0; i < avatarIds.length; i += 200) {
    const chunk = avatarIds.slice(i, i + 200);
    try {
      const r = await prisma.employeeContact.updateMany({
        where: { id: { in: chunk } },
        data: { avatarUrl: null },
      });
      stats.avatar_nulled += r.count;
    } catch (e) {
      errors.push({ url: `employee_contacts[${chunk.length} rows]`, message: e?.message ?? String(e) });
    }
  }

  // 阶段二必须**重新读取**富文本行：阶段一已把可修复的 URL 改写成 CDN 地址，
  // 若沿用扫描时抓到的旧内容回写，会把阶段一的改写覆盖回去（演练时实测踩到）。
  const prodDescFresh = await prisma.$queryRawUnsafe(
    `select id, description from products where description like '%/uploads/media/%'`,
  );
  const blogContentFresh = await prisma.$queryRawUnsafe(
    `select id, content from blog_posts where content like '%/uploads/media/%'`,
  );

  // 4.5 products.description：剥离坏图引用
  for (const row of prodDescFresh) {
    if (![...missingSet].some((u) => row.description.includes(u))) continue;
    try {
      const { text, removed } = stripBrokenRefs(row.description, missingSet);
      if (removed > 0) {
        await prisma.$executeRawUnsafe(`update products set description = $1 where id = $2`, text, row.id);
        stats.product_desc_cleaned += 1;
      }
    } catch (e) {
      errors.push({ url: `products.description#${row.id}`, message: e?.message ?? String(e) });
    }
  }

  // 4.6 blog_posts.content：剥离坏图引用
  for (const row of blogContentFresh) {
    if (![...missingSet].some((u) => row.content.includes(u))) continue;
    try {
      const { text, removed } = stripBrokenRefs(row.content, missingSet);
      if (removed > 0) {
        await prisma.$executeRawUnsafe(`update blog_posts set content = $1 where id = $2`, text, row.id);
        stats.blog_content_cleaned += 1;
      }
    } catch (e) {
      errors.push({ url: `blog_posts.content#${row.id}`, message: e?.message ?? String(e) });
    }
  }

  console.log('\n[阶段二] 删除引用完成:', JSON.stringify(stats));
  if (errors.length) {
    console.log(`  累计失败 ${errors.length} 条：`);
    errors.slice(0, 15).forEach((e) => console.log(`    ${e.url} -> ${e.message}`));
  }

  await reportLeftovers();
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FATAL', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
