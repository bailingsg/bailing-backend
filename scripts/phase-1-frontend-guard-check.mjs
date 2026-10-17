/**
 * Phase 1「前台真实渲染」验收脚本（后端 + 前台同时在线才能跑）。
 *
 * 与 public-guard-check.mjs 的分工：
 *   · public-guard      断言**后端公开接口**返回什么
 *   · frontend-guard    断言**访客实际拿到的 HTML 页**是什么（含 Next 路由缓存）
 *
 * 这条链路验证了前台真正的行为契约：
 *   未发布 / 已下架 → /products/<slug> 返回 HTTP 404 页面
 *   已发布           → /products/<slug> 返回 HTTP 200 且含产品名
 *   不存在           → 404，且与「未发布」页面一致（不泄漏存在性）
 *
 * 前置：
 *   1. 后端已启动（默认 http://127.0.0.1:4000/api/v1）
 *   2. 前台已 `npm run build` + `npm run start`（默认 http://127.0.0.1:3000）
 *   3. 前台 .env 的 NEXT_PUBLIC_CMS_SOURCE=api（否则走 demo 数据，本脚本无意义）
 *
 * 用法：
 *   node scripts/phase-1-frontend-guard-check.mjs
 *   FRONTEND_URL=http://127.0.0.1:3000 BASE_URL=http://127.0.0.1:4000/api/v1 node scripts/...
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4000/api/v1';
const FRONTEND = process.env.FRONTEND_URL ?? 'http://127.0.0.1:3000';

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
    /* 依赖真实环境变量 */
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

/** 访客视角：直接取前台页面 HTML（不缓存、不跟随代理） */
async function visit(path) {
  const res = await fetch(`${FRONTEND}${path}`, { headers: { 'Cache-Control': 'no-cache' } });
  const text = await res.text();
  return { status: res.status, text };
}

const data = (body) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

async function main() {
  console.log(`Phase 1 前台真实渲染验收`);
  console.log(`  后端 ${BASE}`);
  console.log(`  前台 ${FRONTEND}\n`);

  /* 0) 前置探活 */
  const home = await visit('/');
  if (home.status !== 200) {
    console.error(`前台不可访问（HTTP ${home.status}），请先 npm run build && npm run start`);
    process.exit(1);
  }
  console.log('[1/6] 前台/后端在线\n');

  const login = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (login.status !== 200) {
    console.error(`登录失败：HTTP ${login.status}`);
    process.exit(1);
  }
  const token = data(login.body).accessToken;

  const categories = await call('/cms/product-categories', {}, token);
  const catList = data(categories.body);
  const categoryId = Array.isArray(catList) ? catList[0]?.id : catList?.items?.[0]?.id;
  if (!categoryId) {
    console.error('没有可用产品分类');
    process.exit(1);
  }

  const stamp = Date.now().toString(36);
  const slug = `phase1-fe-${stamp}`;
  const ghostSlug = `phase1-fe-ghost-${stamp}`;
  const title = `Phase1 前台验收 ${stamp}`;

  /* 1) 建草稿 */
  const created = await call(
    '/cms/products',
    {
      method: 'POST',
      body: JSON.stringify({
        name: title,
        slug,
        description: 'Phase 1 前台渲染验收用，脚本结束会自动删除。',
        categoryId,
      }),
    },
    token,
  );
  const productId = data(created.body)?.id;
  if (!productId) {
    console.error(`创建失败：HTTP ${created.status} ${created.text}`);
    process.exit(1);
  }
  console.log('[2/6] 测试产品已创建（DRAFT）\n');

  /* 2) DRAFT → 前台 404 */
  const draftPage = await visit(`/products/${slug}`);
  check('DRAFT → 前台页面 404', draftPage.status === 404, `HTTP ${draftPage.status}`);

  /* 3) 不存在的 slug → 404 且与 DRAFT 一致 */
  const ghostPage = await visit(`/products/${ghostSlug}`);
  check('不存在 → 前台页面 404', ghostPage.status === 404, `HTTP ${ghostPage.status}`);

  /* 4) 发布 → 前台 200 且含产品名 */
  await call(`/cms/products/${productId}/publish`, { method: 'POST' }, token);
  const livePage = await visit(`/products/${slug}`);
  check('PUBLISHED → 前台页面 200', livePage.status === 200, `HTTP ${livePage.status}`);
  check(
    'PUBLISHED → 页面含产品名',
    livePage.text.includes(title),
    livePage.text.includes(title) ? '命中' : '未找到产品名',
  );

  /* 5) 取消发布 → 前台回到 404（缓存必须被失效掉） */
  await call(`/cms/products/${productId}/unpublish`, { method: 'POST' }, token);
  const gonePage = await visit(`/products/${slug}`);
  check('UNPUBLISHED → 前台页面 404', gonePage.status === 404, `HTTP ${gonePage.status}`);
  check(
    'UNPUBLISHED → 页面不再含产品名',
    gonePage.text.includes(title) === false,
    gonePage.text.includes(title) ? '仍能看到产品名（缓存未失效）' : '已下线',
  );

  /* 6) 清理 */
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
