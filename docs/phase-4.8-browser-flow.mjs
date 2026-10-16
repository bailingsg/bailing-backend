/**
 * Phase 4.8 —— 前台浏览器全流程验证（Playwright 直连，单会话）
 *
 * 前置：
 *   · postgres(5432) / backend(4000) / admin(3001) / ui(3000, NEXT_PUBLIC_CMS_SOURCE=api) 已启动
 *
 * 覆盖任务书：
 *   §四十六~五十一  Playwright 全流程 + 响应式 375 / 390 / 768 / 1440
 *   §十二          CMS 发布 → 前台即时反映（浏览器视角端到端）
 *   §三十一        不存在 / 未发布内容 → 真实 404（非软 404）
 *   §十三~十八     真实浏览器中 title / canonical 正确
 *   §三十三        无 console error / pageerror
 *
 * 用法：node docs/phase-4.8-browser-flow.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright');

const UI = 'http://127.0.0.1:3000';
const API = 'http://127.0.0.1:4000/api/v1';
const SHOT_DIR = 'D:/com.bailingwooden/bailing-backend/docs/screenshots/phase-4.8';
const DEMO_SLUG = 'demo-wood-panel';
const MARK = `Phase48 浏览器链路验证 ${Date.now().toString(36)}`;

const results = [];
/** 故意触发的 404 路径（这些导航产生的资源加载错误不计入 console error） */
const INTENTIONAL_404 = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  -- ${detail}` : ''}`);
}

let TOKEN = null;
async function api(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // 登录后端（用于发布即刷新 / 数据还原）
  {
    const res = await api('POST', '/auth/login', {
      email: 'admin@bailingwooden.com',
      password: '123456789',
    });
    TOKEN = res.body?.data?.accessToken ?? null;
    check('0.1 后端管理员登录', Boolean(TOKEN), TOKEN ? 'ok' : JSON.stringify(res.body)?.slice(0, 120));
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage();

  const consoleErrors = [];
  const noteError = (text) => consoleErrors.push({ url: page.url(), text: text.slice(0, 200) });
  page.on('console', (m) => {
    if (m.type() === 'error') noteError(m.text());
  });
  page.on('pageerror', (e) => noteError(`pageerror: ${e.message}`));

  /* ------------------------------------------------------------------ */
  console.log('\n=== A. 前台页面渲染（api 模式，真实浏览器） ===');
  /* ------------------------------------------------------------------ */

  const frontPages = [
    { name: 'A1 首页', url: '/', marker: 'Bailing Wooden', shot: 'home-1440.png' },
    { name: 'A2 产品列表', url: '/products', marker: 'Demo · Wood Panel', shot: 'products-1440.png' },
    { name: 'A3 产品详情', url: `/products/${DEMO_SLUG}`, marker: 'Demo · Wood Panel', shot: 'product-detail-1440.png' },
    { name: 'A4 应用场景', url: '/applications', marker: 'Applications', shot: 'applications-1440.png' },
    { name: 'A5 工厂实力', url: '/factory', marker: 'Factory', shot: 'factory-1440.png' },
    { name: 'A6 质量体系', url: '/quality', marker: 'Quality', shot: 'quality-1440.png' },
    { name: 'A7 关于我们', url: '/about', marker: 'About', shot: 'about-1440.png' },
    { name: 'A8 资讯列表', url: '/blog', marker: 'Insight', shot: 'blog-1440.png' },
    { name: 'A9 联系我们', url: '/contact', marker: 'Request', shot: 'contact-1440.png' },
  ];

  for (const t of frontPages) {
    const res = await page.goto(`${UI}${t.url}`, { waitUntil: 'load', timeout: 45000 });
    const html = await page.content();
    check(
      `${t.name} 200 且含预期内容`,
      res?.status() === 200 && html.includes(t.marker),
      `status=${res?.status()} marker="${t.marker}"`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, t.shot), fullPage: false });
  }

  /* ------------------------------------------------------------------ */
  console.log('\n=== B. 真实浏览器中的 SEO 元素 ===');
  /* ------------------------------------------------------------------ */

  {
    const res = await page.goto(`${UI}/products/${DEMO_SLUG}`, { waitUntil: 'load', timeout: 45000 });
    check('B1 产品详情 200', res?.status() === 200, `status=${res?.status()}`);
    check('B2 <title> 正确', (await page.title()).includes('Demo · Wood Panel'), await page.title());
    const canonical = await page.getAttribute('link[rel="canonical"]', 'href');
    check(
      'B3 canonical 为生产域名',
      Boolean(canonical) && canonical.includes('bailingwooden.com') && !/localhost|192\.168\./.test(canonical),
      canonical ?? '(缺失)',
    );
    const ogTitle = await page.getAttribute('meta[property="og:title"]', 'content');
    check('B4 og:title 存在', Boolean(ogTitle), ogTitle ?? '(缺失)');
    const ld = await page.locator('script[type="application/ld+json"]').count();
    check('B5 JSON-LD 脚本存在', ld > 0, `${ld} 块`);
  }

  /* ------------------------------------------------------------------ */
  console.log('\n=== C. 真实 404（非软 404） ===');
  /* ------------------------------------------------------------------ */

  for (const [name, url] of [
    ['C1 不存在的产品', '/products/definitely-not-exist'],
    ['C2 不存在的文章', '/blog/no-such-post-xyz'],
    ['C3 不存在的应用场景', '/applications/no-such-application'],
  ]) {
    INTENTIONAL_404.push(url);
    const res = await page.goto(`${UI}${url}`, { waitUntil: 'load', timeout: 45000 });
    const html = await page.content();
    check(`${name} 返回 404`, res?.status() === 404, `status=${res?.status()}`);
    check(
      `${name} 展示 not-found 界面`,
      /not found|404/i.test(html),
      html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '',
    );
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '404-page.png') });

  /* ------------------------------------------------------------------ */
  console.log('\n=== D. 发布即刷新（浏览器端到端，§十二） ===');
  /* ------------------------------------------------------------------ */

  const list = await api('GET', '/cms/products');
  const rows = list.body?.data?.items ?? list.body?.data ?? [];
  const demo = rows.find((r) => r.slug === DEMO_SLUG);
  const originalName = demo?.name ?? '';

  if (!demo) {
    check('D0 找到演示产品', false, '未找到，跳过 D');
  } else {
    const renamed = `${originalName} · ${MARK}`;

    // D1 后台改名
    const patched = await api('PATCH', `/cms/products/${demo.id}`, { name: renamed });
    check('D1 后台修改产品名', patched.status === 200, `HTTP ${patched.status}`);

    // D2 新开浏览器会话访问 → 应看到新名称（不重建、不清缓存）
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page2 = await ctx2.newPage();
    let seen = false;
    for (let i = 0; i < 20 && !seen; i += 1) {
      const r = await page2.goto(`${UI}/products/${DEMO_SLUG}`, { waitUntil: 'load', timeout: 45000 });
      const html = await page2.content();
      seen = r?.status() === 200 && html.includes(renamed);
      if (!seen) await new Promise((s) => setTimeout(s, 500));
    }
    check('D2 前台即时显示新名称（发布即刷新）', seen);
    await page2.screenshot({ path: path.join(SHOT_DIR, 'publish-refresh.png') });
    await ctx2.close();

    // D3 还原
    const restored = await api('PATCH', `/cms/products/${demo.id}`, { name: originalName });
    check('D3 数据还原', restored.status === 200, `HTTP ${restored.status}`);
    await new Promise((s) => setTimeout(s, 1500));
    const back = await page.goto(`${UI}/products/${DEMO_SLUG}`, { waitUntil: 'load', timeout: 45000 });
    const backHtml = await page.content();
    check('D4 还原后前台同步', back?.status() === 200 && backHtml.includes(originalName), `HTTP ${back?.status()}`);
  }

  /* ------------------------------------------------------------------ */
  console.log('\n=== E. 响应式（375 / 390 / 768 / 1440，无横向溢出） ===');
  /* ------------------------------------------------------------------ */

  const responsivePages = ['/', '/products', `/products/${DEMO_SLUG}`, '/applications', '/blog', '/contact'];
  for (const vp of [
    { width: 375, height: 812, label: '375' },
    { width: 390, height: 844, label: '390' },
    { width: 768, height: 1024, label: '768' },
    { width: 1440, height: 900, label: '1440' },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const p of responsivePages) {
      await page.goto(`${UI}${p}`, { waitUntil: 'load', timeout: 45000 });
      const { scrollWidth, clientWidth } = await overflow(page);
      const ok = scrollWidth <= clientWidth + 1;
      check(`E ${vp.label} ${p} 无横向溢出`, ok, `scroll=${scrollWidth} client=${clientWidth}`);
    }
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`${UI}/`, { waitUntil: 'load', timeout: 45000 });
    await page.screenshot({ path: path.join(SHOT_DIR, `home-${vp.label}.png`), fullPage: false });
  }

  /* ------------------------------------------------------------------ */
  console.log('\n=== F. 控制台错误 ===');
  /* ------------------------------------------------------------------ */

  // 过滤掉浏览器扩展 / 网络探测类噪声，以及**故意**触发的 404 导航所产生的资源加载错误
  const realErrors = consoleErrors
    .filter((e) => !/favicon|net::ERR_|Download the React DevTools/i.test(e.text))
    .filter((e) => !INTENTIONAL_404.some((p) => e.url.includes(p)));
  check(
    'F1 全流程无 console error / pageerror',
    realErrors.length === 0,
    realErrors.slice(0, 3).map((e) => `${e.url} :: ${e.text}`).join(' | ') || '无',
  );

  await browser.close();

  /* ------------------------------------------------------------------ */
  console.log('\n=== 汇总 ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('\n失败项：');
    failed.forEach((r) => console.log(`  - ${r.name} :: ${r.detail}`));
  }
  console.log(failed.length === 0 ? '\n✓ 全部通过' : '\n✗ 存在失败项');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
