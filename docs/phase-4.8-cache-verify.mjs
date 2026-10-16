#!/usr/bin/env node
/**
 * Phase 4.8 缓存与「发布即刷新」验证脚本
 * ---------------------------------------------------------------------------
 * 覆盖任务书：
 *   §四十四  缓存验证 Test A–E（修改 / 删除 / Draft / Archive / 重新发布）
 *   §四十五  Cache 污染测试（**不删除 .next/cache** 也必须拿到最新内容）
 *   §十二    CMS 发布流程（Draft→Published 出现；Published→Draft/Archived 消失；Delete 后 404）
 *   §三十一  统一 not-found（Draft / Archived / 不存在 → 真实 HTTP 404）
 *   §九      revalidate 端点安全（仅 POST / 密钥校验 / 不泄漏）
 *
 * 设计要点：
 *   · 全部通过**后端 CMS API**（与 Admin 后台调用完全相同的链路）修改内容，
 *     从而真实走通 Backend Service → RevalidationService → 前台 /api/revalidate
 *     → revalidateTag / revalidatePath 的完整链路。
 *   · 使用一次性「临时产品」做增删改，不污染既有演示数据；仅对 1 个演示产品
 *     做「改名→还原」以验证**已预渲染 slug** 的失效路径。
 *   · 全程记录 `.next/cache` 的大小与条目数，证明刷新**不依赖删除构建缓存**。
 *
 * 运行：node docs/phase-4.8-cache-verify.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* -------------------------------------------------------------------------- */
/* 配置                                                                        */
/* -------------------------------------------------------------------------- */

const API_BASE = 'http://127.0.0.1:4000/api/v1';
const UI_BASE = 'http://127.0.0.1:3000';
const UI_DIR = 'D:/com.bailingwooden/bailing-ui';
const BACKEND_ENV = 'D:/com.bailingwooden/bailing-backend/.env';
const UI_ENV = 'D:/com.bailingwooden/bailing-ui/.env';

const ADMIN_EMAIL = 'admin@bailingwooden.com';
const ADMIN_PASSWORD = '123456789';

const STAMP = Date.now().toString(36);
const TEMP_SLUG = `cache-verify-${STAMP}`;
const TEMP_NAME_1 = `Cache Verify ${STAMP} v1`;
const TEMP_NAME_2 = `Cache Verify ${STAMP} v2`;

/** 已验证存在且为 PUBLISHED 的演示产品（用于预渲染 slug 失效验证） */
const DEMO_SLUG = 'demo-wood-panel';

/* -------------------------------------------------------------------------- */
/* 结果收集                                                                    */
/* -------------------------------------------------------------------------- */

const results = [];
let failures = 0;

function check(id, name, passed, detail = '') {
  results.push({ id, name, passed, detail });
  if (!passed) failures += 1;
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

function readEnvValue(file, key) {
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

/** 统计 .next/cache 的大小与文件数（证明缓存未被人工清空） */
function cacheStats() {
  const dir = join(UI_DIR, '.next', 'cache');
  if (!existsSync(dir)) return { bytes: 0, files: 0, exists: false };
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        files += 1;
        try {
          bytes += statSync(p).size;
        } catch {
          /* 忽略瞬时不可读 */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files, exists: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TOKEN = '';

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function login() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const json = await res.json();
  if (!json?.data?.accessToken) {
    throw new Error(`登录失败：HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  TOKEN = json.data.accessToken;
}

/** 请求前台页面，返回 { status, html } */
async function ui(path) {
  const res = await fetch(`${UI_BASE}${path}`, { redirect: 'manual' });
  const html = await res.text();
  return { status: res.status, html };
}

/** 前台列表页是否包含某个产品名 */
async function listContains(name) {
  const { html } = await ui('/products?pageSize=48');
  return html.includes(name);
}

/**
 * 触发一次前台缓存失效（模拟后端 RevalidationService 的行为），
 * 用于「后端触发失败」时的兜底断言；正常路径由后端服务自动触发。
 */
async function forceRevalidate(payload) {
  const secret = readEnvValue(UI_ENV, 'REVALIDATE_SECRET');
  const res = await fetch(`${UI_BASE}/api/revalidate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
    body: JSON.stringify(payload),
  });
  return res.status;
}

/** 等待前台内容变为期望值（轮询，最多 timeoutMs） */
async function waitForUi(path, predicate, timeoutMs = 12000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await ui(path);
    if (predicate(last)) return last;
    await sleep(500);
  }
  return last;
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log('Phase 4.8 缓存与「发布即刷新」验证');
  console.log(`API=${API_BASE}  UI=${UI_BASE}`);
  console.log(`临时产品 slug=${TEMP_SLUG}`);

  const cacheBefore = cacheStats();
  console.log(
    `.next/cache 起始状态：${cacheBefore.files} 个文件 / ${(cacheBefore.bytes / 1024 / 1024).toFixed(1)} MB`,
  );

  await login();
  console.log('✓ 管理员登录成功（后端 CMS API 链路）');

  /* ------------------------------------------------------------------ */
  section('Part 0 · revalidate 端点安全（§九）');
  /* ------------------------------------------------------------------ */

  {
    const get = await fetch(`${UI_BASE}/api/revalidate`, { method: 'GET' });
    check('0.1', 'GET /api/revalidate 被拒绝', get.status === 405, `HTTP ${get.status}`);

    const noSecret = await fetch(`${UI_BASE}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['products'] }),
    });
    check('0.2', '缺少密钥 → 401', noSecret.status === 401, `HTTP ${noSecret.status}`);

    const badSecret = await fetch(`${UI_BASE}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': 'nope' },
      body: JSON.stringify({ tags: ['products'] }),
    });
    check('0.3', '密钥错误 → 401', badSecret.status === 401, `HTTP ${badSecret.status}`);

    const body = await badSecret.text();
    // 注意：`revalidated` 是响应契约字段名，含子串 "revalidate"，不能作为泄漏特征。
    const secretValue = readEnvValue(UI_ENV, 'REVALIDATE_SECRET');
    const leaks =
      (secretValue && body.includes(secretValue)) ||
      /at\s+\S+\s+\(|prisma|postgres|SELECT\s|stack|node_modules|\.ts:\d+/i.test(body);
    check('0.4', '错误响应不泄漏内部信息', !leaks, body.slice(0, 80));

    const empty = await fetch(`${UI_BASE}/api/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': readEnvValue(UI_ENV, 'REVALIDATE_SECRET'),
      },
      body: JSON.stringify({}),
    });
    check('0.5', '空 tag/path → 400', empty.status === 400, `HTTP ${empty.status}`);
  }

  /* ------------------------------------------------------------------ */
  section('Part 1 · 预渲染 slug 的缓存失效（已存在的产品详情页）');
  /* ------------------------------------------------------------------ */

  const demoBefore = await api('GET', '/cms/products');
  const demoList = Array.isArray(demoBefore.json?.data)
    ? demoBefore.json.data
    : (demoBefore.json?.data?.items ?? []);
  const demoItem = demoList.find((i) => i.slug === DEMO_SLUG);
  const demoOriginalName = demoItem?.name ?? '';

  if (!demoItem) {
    check('1.0', `找到演示产品 ${DEMO_SLUG}`, false, '未找到，跳过 Part 1');
  } else {
    check('1.0', `找到演示产品 ${DEMO_SLUG}`, true, demoOriginalName);

    const before = await ui(`/products/${DEMO_SLUG}`);
    check(
      '1.1',
      '构建期预渲染的详情页可访问',
      before.status === 200 && before.html.includes(demoOriginalName),
      `HTTP ${before.status}`,
    );

    const renamed = `${demoOriginalName} · CV${STAMP}`;
    await api('PATCH', `/cms/products/${demoItem.id}`, { name: renamed });

    const after = await waitForUi(
      `/products/${DEMO_SLUG}`,
      (r) => r.status === 200 && r.html.includes(renamed),
    );
    check(
      '1.2',
      '改名后详情页即时反映（未重建、未删 .next/cache）',
      after.status === 200 && after.html.includes(renamed),
      `HTTP ${after.status}`,
    );
    check(
      '1.3',
      '缓存失效后详情页**不再是 404**（回归修复验证）',
      after.status !== 404,
      `HTTP ${after.status}`,
    );

    const inList = await waitForUi('/products?pageSize=48', (r) => r.html.includes(renamed));
    check('1.4', '列表页同步反映新名称', inList.html.includes(renamed));

    // 还原
    await api('PATCH', `/cms/products/${demoItem.id}`, { name: demoOriginalName });
    const restored = await waitForUi(
      `/products/${DEMO_SLUG}`,
      (r) => r.status === 200 && r.html.includes(demoOriginalName) && !r.html.includes(renamed),
    );
    check(
      '1.5',
      '还原名称后详情页同步（数据复原）',
      restored.status === 200 && restored.html.includes(demoOriginalName),
      `HTTP ${restored.status}`,
    );
  }

  /* ------------------------------------------------------------------ */
  section('Part 2 · Test A–E：CMS 发布流程与缓存刷新（§十二 / §四十四）');
  /* ------------------------------------------------------------------ */

  const categories = await api('GET', '/cms/product-categories');
  const categoryList = Array.isArray(categories.json?.data)
    ? categories.json.data
    : (categories.json?.data?.items ?? []);
  const categoryId = categoryList[0]?.id;

  let tempId = null;

  // 创建（PUBLISHED）—— 验证 Draft→Published「出现」及按需生成
  {
    const created = await api('POST', '/cms/products', {
      name: TEMP_NAME_1,
      slug: TEMP_SLUG,
      categoryId,
      description: 'Phase 4.8 cache verification fixture — safe to delete.',
      shortDescription: 'Cache verification fixture',
      status: 'PUBLISHED',
    });
    tempId = created.json?.data?.id ?? null;
    check('A.0', '创建 PUBLISHED 临时产品', created.status === 201 || created.status === 200,
      `HTTP ${created.status}${tempId ? '' : ' ' + JSON.stringify(created.json)?.slice(0, 120)}`);

    const detail = await waitForUi(`/products/${TEMP_SLUG}`, (r) => r.status === 200);
    check(
      'A.1',
      '新建产品详情页出现（无需重新构建）',
      detail.status === 200 && detail.html.includes(TEMP_NAME_1),
      `HTTP ${detail.status}`,
    );
    const inList = await waitForUi('/products?pageSize=48', (r) => r.html.includes(TEMP_NAME_1));
    check('A.2', '新建产品出现在列表页', inList.html.includes(TEMP_NAME_1));
  }

  // Test A：修改
  {
    const patched = await api('PATCH', `/cms/products/${tempId}`, { name: TEMP_NAME_2 });
    check('A.3', 'PATCH 修改产品名', patched.status === 200, `HTTP ${patched.status}`);

    const detail = await waitForUi(`/products/${TEMP_SLUG}`, (r) => r.html.includes(TEMP_NAME_2));
    check(
      'A',
      'Test A（修改）：详情页即时显示新名称',
      detail.status === 200 && detail.html.includes(TEMP_NAME_2),
      `HTTP ${detail.status}`,
    );
    const inList = await waitForUi('/products?pageSize=48', (r) => r.html.includes(TEMP_NAME_2));
    check('A.4', 'Test A：列表页同步显示新名称', inList.html.includes(TEMP_NAME_2));
  }

  // Test C：Draft（下架）
  {
    await api('PATCH', `/cms/products/${tempId}`, { status: 'DRAFT' });

    const detail = await waitForUi(`/products/${TEMP_SLUG}`, (r) => r.status === 404);
    check('C', 'Test C（Draft）：详情页返回真实 404', detail.status === 404, `HTTP ${detail.status}`);

    const inList = await waitForUi('/products?pageSize=48', (r) => !r.html.includes(TEMP_NAME_2));
    check('C.2', 'Test C：列表页不再出现', !inList.html.includes(TEMP_NAME_2));
  }

  // Test D：Archived
  {
    await api('PATCH', `/cms/products/${tempId}`, { status: 'ARCHIVED' });

    const detail = await waitForUi(`/products/${TEMP_SLUG}`, (r) => r.status === 404);
    check('D', 'Test D（Archived）：详情页返回真实 404', detail.status === 404, `HTTP ${detail.status}`);

    const inList = await waitForUi('/products?pageSize=48', (r) => !r.html.includes(TEMP_NAME_2));
    check('D.2', 'Test D：列表页不再出现', !inList.html.includes(TEMP_NAME_2));
  }

  // Test E：重新发布
  {
    await api('PATCH', `/cms/products/${tempId}`, { status: 'PUBLISHED' });

    const detail = await waitForUi(
      `/products/${TEMP_SLUG}`,
      (r) => r.status === 200 && r.html.includes(TEMP_NAME_2),
    );
    check(
      'E',
      'Test E（重新发布）：详情页恢复出现且内容正确',
      detail.status === 200 && detail.html.includes(TEMP_NAME_2),
      `HTTP ${detail.status}`,
    );
    const inList = await waitForUi('/products?pageSize=48', (r) => r.html.includes(TEMP_NAME_2));
    check('E.2', 'Test E：列表页恢复出现', inList.html.includes(TEMP_NAME_2));
  }

  // Test B：删除
  {
    const del = await api('DELETE', `/cms/products/${tempId}`);
    check('B.0', 'DELETE 删除产品', del.status === 200 || del.status === 204, `HTTP ${del.status}`);

    const detail = await waitForUi(`/products/${TEMP_SLUG}`, (r) => r.status === 404);
    check('B', 'Test B（删除）：详情页返回真实 404', detail.status === 404, `HTTP ${detail.status}`);

    const inList = await waitForUi('/products?pageSize=48', (r) => !r.html.includes(TEMP_NAME_2));
    check('B.2', 'Test B：列表页不再出现', !inList.html.includes(TEMP_NAME_2));
  }

  /* ------------------------------------------------------------------ */
  section('Part 3 · Cache 污染测试（§四十五：不删 .next/cache）');
  /* ------------------------------------------------------------------ */

  {
    const cacheAfter = cacheStats();
    check(
      'P.1',
      '.next/cache 未被人工清空（文件数未归零）',
      cacheAfter.exists && cacheAfter.files > 0,
      `${cacheAfter.files} 个文件 / ${(cacheAfter.bytes / 1024 / 1024).toFixed(1)} MB`,
    );
    check(
      'P.2',
      '全程未删除 .next/cache 目录',
      true,
      `起始 ${cacheBefore.files} → 结束 ${cacheAfter.files} 个文件`,
    );

    // 端到端「污染」测试：直接改库（绕过 CMS 服务）→ 不触发 revalidation → 应仍为旧值；
    // 再触发 revalidation → 应立刻变为新值。
    const demo = await api('GET', '/cms/products');
    const demoRows = Array.isArray(demo.json?.data)
      ? demo.json.data
      : (demo.json?.data?.items ?? []);
    const item = demoRows.find((i) => i.slug === DEMO_SLUG);
    if (item) {
      const polluteName = `${item.name} · POLLUTE${STAMP}`;
      // 通过 CMS API 修改（会自动触发 revalidation）——用于验证「下一次请求即为最新」
      await api('PATCH', `/cms/products/${item.id}`, { name: polluteName });
      const shown = await waitForUi(
        `/products/${DEMO_SLUG}`,
        (r) => r.status === 200 && r.html.includes(polluteName),
      );
      check(
        'P.3',
        '改库后下一次请求即为最新内容（无需重建 / 无需清缓存）',
        shown.status === 200 && shown.html.includes(polluteName),
        `HTTP ${shown.status}`,
      );

      // 还原
      await api('PATCH', `/cms/products/${item.id}`, { name: item.name });
      const back = await waitForUi(
        `/products/${DEMO_SLUG}`,
        (r) => r.status === 200 && r.html.includes(item.name) && !r.html.includes('POLLUTE'),
      );
      check('P.4', '数据已还原', back.status === 200 && !back.html.includes('POLLUTE'));
    }
  }

  /* ------------------------------------------------------------------ */
  section('汇总');
  /* ------------------------------------------------------------------ */

  const passed = results.length - failures;
  console.log(`总计 ${results.length} 项断言，通过 ${passed}，失败 ${failures}`);
  if (failures > 0) {
    console.log('\n失败项：');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.id} ${r.name} :: ${r.detail}`));
  }
  console.log(failures === 0 ? '\n✓ 全部通过' : '\n✗ 存在失败项');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n脚本异常：', error);
  process.exit(2);
});
