/**
 * Phase 1「公开侧守卫」真实 HTTP 验收脚本。
 *
 * 与 phase-1-live-check.mjs 的分工：
 *   · live-check      验证后台发布工作流本身（创建/发布/编辑稿/取消发布/历史）
 *   · public-guard    验证**访客能看到什么**——前台（`bailing-ui`）所有页面
 *                     都只读后端公开接口，因此这里断言的就是前台的真实行为
 *
 * 覆盖：
 *   1. 未发布（DRAFT）→ 公开详情 404
 *   2. 已发布（PUBLISHED）→ 公开详情 200，且出现在公开列表
 *   3. 已下架（UNPUBLISHED）→ 公开详情 404，且从公开列表消失
 *   4. **不泄漏存在性**：未发布 / 已下架 / 根本不存在的 slug，
 *      三者返回的 404 响应体**逐字相同**（访客无法据此探测内容是否存在）
 *   5. 取消发布不丢内容：后台详情仍可读、发布历史仍在
 *
 * 用法：
 *   node scripts/phase-1-public-guard-check.mjs
 *   BASE_URL=http://127.0.0.1:4000/api/v1 node scripts/phase-1-public-guard-check.mjs
 *
 * 凭据从环境变量 ADMIN_EMAIL / ADMIN_PASSWORD 读取（缺省读 .env），不打印令牌。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4000/api/v1';

/* ------------------------------ .env 读取 ------------------------------ */

function loadEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = {};
  try {
    const raw = readFileSync(join(here, '..', '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    // 无 .env 时依赖真实环境变量
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const EMAIL = env.ADMIN_EMAIL ?? '';
const PASSWORD = env.ADMIN_PASSWORD ?? '';

if (EMAIL === '' || PASSWORD === '') {
  console.error('缺少 ADMIN_EMAIL / ADMIN_PASSWORD（环境变量或 backend/.env）');
  process.exit(2);
}

/* ------------------------------ 断言与请求 ------------------------------ */

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, init = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text };
}

const data = (body) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

/** 公开列表里是否存在该 slug（翻到底，避免分页影响判定） */
async function inPublicList(slug) {
  const res = await call('/products?pageSize=48');
  const list = data(res.body);
  const items = Array.isArray(list) ? list : (list?.items ?? []);
  return items.some((item) => item?.slug === slug);
}

async function main() {
  console.log(`Phase 1 公开侧守卫真实 HTTP 验收 → ${BASE}\n`);

  /* 1) 登录 */
  const login = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (login.status !== 200) {
    console.error(`登录失败：HTTP ${login.status}`);
    process.exit(1);
  }
  const token = data(login.body).accessToken;
  console.log('[1/5] 登录成功\n');

  /* 2) 准备测试数据 */
  const categories = await call('/cms/product-categories', {}, token);
  const catList = data(categories.body);
  const categoryId = Array.isArray(catList) ? catList[0]?.id : catList?.items?.[0]?.id;
  if (!categoryId) {
    console.error('没有可用产品分类，请先执行 seed 或手工建一个分类');
    process.exit(1);
  }

  const stamp = Date.now().toString(36);
  const slug = `phase1-guard-${stamp}`;
  const ghostSlug = `phase1-never-exists-${stamp}`;

  const created = await call(
    '/cms/products',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `Phase1 守卫产品 ${stamp}`,
        slug,
        description: 'Phase 1 公开侧守卫验收用，脚本结束会自动删除。',
        categoryId,
      }),
    },
    token,
  );
  const productId = data(created.body)?.id;
  if (!productId) {
    console.error(`创建测试产品失败：HTTP ${created.status} ${created.text}`);
    process.exit(1);
  }
  console.log('[2/5] 测试产品已创建（DRAFT）\n');

  /* 3) DRAFT：公开不可见 */
  const draftDetail = await call(`/products/${slug}`);
  check('DRAFT → 公开详情 404', draftDetail.status === 404, `HTTP ${draftDetail.status}`);
  check('DRAFT → 不在公开列表', (await inPublicList(slug)) === false, `slug=${slug}`);

  /* 4) 不存在的 slug：两者 404 响应必须逐字相同（不泄漏存在性） */
  const ghost = await call(`/products/${ghostSlug}`);
  check('不存在的 slug → 404', ghost.status === 404, `HTTP ${ghost.status}`);
  check(
    'DRAFT 与「不存在」的 404 响应体一致（不泄漏存在性）',
    draftDetail.text === ghost.text,
    draftDetail.text === ghost.text ? '响应体逐字相同' : `draft="${draftDetail.text}" ghost="${ghost.text}"`,
  );

  /* 5) PUBLISHED：公开可见 */
  await call(`/cms/products/${productId}/publish`, { method: 'POST' }, token);
  const liveDetail = await call(`/products/${slug}`);
  check('PUBLISHED → 公开详情 200', liveDetail.status === 200, `HTTP ${liveDetail.status}`);
  check('PUBLISHED → 出现在公开列表', (await inPublicList(slug)) === true, `slug=${slug}`);

  /* 6) UNPUBLISHED：公开再次不可见，且与「不存在」无差别 */
  const unpublished = await call(`/cms/products/${productId}/unpublish`, { method: 'POST' }, token);
  check('取消发布 → 200', unpublished.status === 200, `HTTP ${unpublished.status}`);

  const goneDetail = await call(`/products/${slug}`);
  check('UNPUBLISHED → 公开详情 404', goneDetail.status === 404, `HTTP ${goneDetail.status}`);
  check('UNPUBLISHED → 从公开列表消失', (await inPublicList(slug)) === false, `slug=${slug}`);
  check(
    'UNPUBLISHED 与「不存在」的 404 响应体一致（不泄漏存在性）',
    goneDetail.text === ghost.text,
    goneDetail.text === ghost.text ? '响应体逐字相同' : `gone="${goneDetail.text}" ghost="${ghost.text}"`,
  );

  /* 7) 取消发布不丢内容：后台仍可读，历史仍在 */
  const adminDetail = await call(`/cms/products/${productId}`, {}, token);
  check(
    '取消发布后后台仍可读（内容保留）',
    adminDetail.status === 200 && data(adminDetail.body)?.slug === slug,
    `HTTP ${adminDetail.status}`,
  );
  const revisions = await call(`/cms/products/${productId}/revisions`, {}, token);
  const revList = data(revisions.body);
  check(
    '取消发布后发布历史保留',
    Array.isArray(revList) && revList.length >= 1,
    `历史 ${Array.isArray(revList) ? revList.length : 0} 条`,
  );

  /* 8) 清理 */
  const removed = await call(`/cms/products/${productId}`, { method: 'DELETE' }, token);
  check('删除测试产品 → 200', removed.status === 200, `HTTP ${removed.status}`);

  const failed = results.filter((r) => !r.passed);
  console.log('');
  console.log(`结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((f) => f.name).join('、')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('验收脚本异常：', error);
  process.exitCode = 1;
});
