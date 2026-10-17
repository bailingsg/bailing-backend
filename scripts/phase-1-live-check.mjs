/**
 * Phase 1 发布工作流 —— 真实 HTTP 验收脚本（本地/预发可重复执行）。
 *
 * 与 e2e 的区别：e2e 走 Nest 应用内注入，本脚本走**真实 HTTP**，
 * 因此同时验证了路由、守卫、ValidationPipe、序列化与公开接口过滤。
 *
 * 覆盖链路（产品为例，其余五类共用同一套引擎，e2e 已逐类覆盖）：
 *   1. 创建 → 恒为 DRAFT，公开站 404
 *   2. 发布 → 公开站 200
 *   3. 已发布后 PATCH → 只写编辑稿，公开站仍是旧内容，preview 显示有未发布修改
 *   4. PATCH 直接带 status → 400（不依赖前端隐藏控件）
 *   5. 取消发布 → 公开站 404，后台内容与历史保留
 *   6. 再次发布 → 公开站显示编辑稿内容，publishedVersion 递增
 *   7. 删除 → 清理测试数据
 *
 * 用法：
 *   node scripts/phase-1-live-check.mjs
 *   BASE_URL=http://127.0.0.1:4000/api/v1 node scripts/phase-1-live-check.mjs
 *
 * 凭据从环境变量 ADMIN_EMAIL / ADMIN_PASSWORD 读取（缺省读 .env），
 * 脚本不打印任何口令或令牌。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4000/api/v1';

/* ------------------------------ .env 读取（仅取两个键） ------------------------------ */

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
    // 没有 .env 时依赖真实环境变量
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
  const headers = {
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

/** 后端统一响应包一层 data */
const data = (body) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

async function main() {
  console.log(`Phase 1 发布工作流真实 HTTP 验收 → ${BASE}\n`);

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
  console.log('[1/8] 登录成功\n');

  /* 2) 取一个分类（产品发布必须有分类） */
  const categories = await call('/cms/product-categories', {}, token);
  const catList = data(categories.body);
  const categoryId = Array.isArray(catList) ? catList[0]?.id : catList?.items?.[0]?.id;
  if (!categoryId) {
    console.error('没有可用产品分类，请先执行 seed 或手工建一个分类');
    process.exit(1);
  }

  const stamp = Date.now().toString(36);
  const slug = `phase1-live-${stamp}`;
  const titleV1 = `Phase1 验收产品 ${stamp}`;
  const titleV2 = `${titleV1}（编辑稿）`;

  /* 3) 创建：恒为 DRAFT */
  const created = await call(
    '/cms/products',
    {
      method: 'POST',
      body: JSON.stringify({
        name: titleV1,
        slug,
        description: 'Phase 1 验收用产品，脚本结束会自动删除。',
        categoryId,
      }),
    },
    token,
  );
  const productId = data(created.body)?.id;
  check('创建产品 → 201', created.status === 201, `HTTP ${created.status}`);
  check('创建后状态为 DRAFT', data(created.body)?.status === 'DRAFT', `status=${data(created.body)?.status}`);

  /* 4) 公开站不可见 */
  const publicBefore = await call(`/products/${slug}`);
  check('未发布 → 公开接口 404', publicBefore.status === 404, `HTTP ${publicBefore.status}`);

  /* 5) 发布 */
  const published = await call(`/cms/products/${productId}/publish`, { method: 'POST' }, token);
  check('发布 → 200', published.status === 200, `HTTP ${published.status}`);
  check(
    '发布后 publishedVersion = 1',
    data(published.body)?.publishedVersion === 1,
    `publishedVersion=${data(published.body)?.publishedVersion}`,
  );

  const publicAfter = await call(`/products/${slug}`);
  check('已发布 → 公开接口 200', publicAfter.status === 200, `HTTP ${publicAfter.status}`);
  check(
    '公开接口返回线上内容',
    data(publicAfter.body)?.name === titleV1,
    `name=${data(publicAfter.body)?.name}`,
  );

  /* 6) 已发布后保存：只写编辑稿 */
  const saved = await call(
    `/cms/products/${productId}`,
    { method: 'PATCH', body: JSON.stringify({ name: titleV2 }) },
    token,
  );
  check('已发布后保存 → 200', saved.status === 200, `HTTP ${saved.status}`);

  const publicStillOld = await call(`/products/${slug}`);
  check(
    '保存后公开站仍是旧内容（保存≠发布）',
    data(publicStillOld.body)?.name === titleV1,
    `name=${data(publicStillOld.body)?.name}`,
  );

  const preview = await call(`/cms/products/${productId}/preview`, {}, token);
  check(
    'preview 标记存在未发布修改',
    data(preview.body)?.hasUnpublishedChanges === true,
    `hasUnpublishedChanges=${data(preview.body)?.hasUnpublishedChanges}`,
  );
  check(
    'preview 编辑稿含新标题',
    data(preview.body)?.draft?.name === titleV2,
    `draft.name=${data(preview.body)?.draft?.name}`,
  );

  /* 7) 直接 PATCH status 必须被拒 */
  const illegal = await call(
    `/cms/products/${productId}`,
    { method: 'PATCH', body: JSON.stringify({ status: 'PUBLISHED' }) },
    token,
  );
  check('PATCH 携带 status → 400', illegal.status === 400, `HTTP ${illegal.status}`);

  /* 8) 取消发布 */
  const unpublished = await call(`/cms/products/${productId}/unpublish`, { method: 'POST' }, token);
  check('取消发布 → 200', unpublished.status === 200, `HTTP ${unpublished.status}`);
  check(
    '取消发布后状态为 UNPUBLISHED',
    data(unpublished.body)?.status === 'UNPUBLISHED',
    `status=${data(unpublished.body)?.status}`,
  );

  const publicGone = await call(`/products/${slug}`);
  check('取消发布 → 公开接口 404', publicGone.status === 404, `HTTP ${publicGone.status}`);

  const revisions = await call(`/cms/products/${productId}/revisions`, {}, token);
  const revList = data(revisions.body);
  check(
    '发布历史保留（v1）',
    Array.isArray(revList) && revList.length >= 1 && revList[0]?.version === 1,
    `历史 ${Array.isArray(revList) ? revList.length : 0} 条`,
  );

  /* 9) 重新发布：编辑稿生效，版本递增 */
  const republished = await call(`/cms/products/${productId}/publish`, { method: 'POST' }, token);
  check(
    '重新发布 → publishedVersion = 2',
    data(republished.body)?.publishedVersion === 2,
    `publishedVersion=${data(republished.body)?.publishedVersion}`,
  );

  const publicV2 = await call(`/products/${slug}`);
  check(
    '重新发布后公开站显示编辑稿内容',
    data(publicV2.body)?.name === titleV2,
    `name=${data(publicV2.body)?.name}`,
  );

  /* 10) 清理 */
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
