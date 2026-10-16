/**
 * Phase 4.7 —— CMS → 前台浏览器全流程验证（Playwright 直连，单会话）
 *
 * 前置：
 *   · postgres(5432) / backend(4000) / admin(3001) / ui(3000, NEXT_PUBLIC_CMS_SOURCE=api) 已启动
 *   · 数据库已 seed（site_sections 11 / nav_items 18）且存在一条已发布验证文章
 *     slug = phase47-verification-post（由验证流程创建，验证后删除）
 *
 * 覆盖：
 *   A. 前台页面（api 模式，消费后端公开 CMS 接口）
 *      A1  首页：CMS hero 正文 + CMS 页眉导航渲染
 *      A2  关于我们：CMS 结构化分区（SiteSectionBlock 卡片 + Learn more 链接）
 *      A3  工厂实力：分区正文（OVERVIEW）+ 图库占位（库中无素材时如实占位）
 *      A4  质量体系：无已发布记录时展示"待补充"框架
 *      A5  应用场景：无已发布场景时正常降级（不崩溃）
 *      A6  博客列表：CMS 已发布文章出现
 *      A7  博客详情：contentHtml 渲染（h2 / ul / blockquote）+ XSS 载荷已剥离
 *      A8  产品列表：接口产品渲染
 *      A9  联系我们：RFQ 表单存在
 *      A10 移动端 375 / 390 / 768 无横向溢出
 *      A11 全流程无 console error
 *   B. 后台（admin 3001）
 *      B1  登录（HttpOnly Cookie 会话）
 *      B2  站点内容列表渲染（中文界面 / 分区键 / 状态徽章）
 *      B3  编辑 home.hero 标题并保存（后台真实写入）
 *      B4  导航管理页渲染
 *   C. 链路闭环
 *      C1  后台保存后，前台首页在 ISR 窗口（300s）内自动出现新标题
 *   D. 收尾
 *      D1  标题经 API 还原（无论 UI 步骤是否成功，保证库内数据回到原值）
 *      D2  截图留档
 *
 * 用法：node docs/phase-4.7-browser-flow.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright');

const UI = 'http://127.0.0.1:3000';
const ADMIN = 'http://127.0.0.1:3001';
const API = 'http://127.0.0.1:4000/api/v1';
const SHOT_DIR = 'D:/com.bailingwooden/bailing-backend/docs/screenshots/phase-4.7';
const MARK = 'PHASE47 Browser 链路验证标题';
const POST_SLUG = 'phase47-verification-post';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  -- ${detail}` : ''}`);
}

/** 后端直连（用于兜底还原，不经过浏览器） */
async function api(method, p, body, token) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function login() {
  const res = await api('POST', '/auth/login', {
    email: 'admin@bailingwooden.com',
    password: '123456789',
  });
  return res.body?.data?.accessToken ?? null;
}

async function horizontalOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 200)}`));

  // ---------------- A. 前台 ----------------
  const frontPages = [
    { name: 'A1 首页', url: '/', marker: 'industrial craftsmanship', shot: 'home-desktop.png' },
    { name: 'A2 关于我们', url: '/about', marker: 'Learn more', shot: 'about-desktop.png' },
    { name: 'A3 工厂实力', url: '/factory', marker: 'Photo to be added', shot: 'factory-desktop.png' },
    { name: 'A4 质量体系', url: '/quality', marker: 'Certificates', shot: 'quality-desktop.png' },
    { name: 'A5 应用场景', url: '/applications', marker: 'Applications', shot: 'applications-desktop.png' },
    { name: 'A6 博客列表', url: '/blog', marker: 'Panel Specification Checklist', shot: 'blog-list.png' },
    { name: 'A8 产品列表', url: '/products', marker: 'Products', shot: 'products-desktop.png' },
    { name: 'A9 联系我们', url: '/contact', marker: 'Request for Quotation', shot: 'contact-desktop.png' },
  ];

  for (const target of frontPages) {
    const response = await page.goto(`${UI}${target.url}`, { waitUntil: 'load', timeout: 45000 });
    const html = await page.content();
    check(
      `${target.name} 渲染 200 且含 CMS/接口内容`,
      response?.status() === 200 && html.includes(target.marker),
      `status=${response?.status()} marker="${target.marker}"`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, target.shot), fullPage: false });
  }

  // A7 博客详情（CMS contentHtml）
  {
    const response = await page.goto(`${UI}/blog/${POST_SLUG}`, { waitUntil: 'load', timeout: 45000 });
    const html = await page.content();
    const prose = await page.locator('.blog-prose').count();
    check('A7 博客详情 200', response?.status() === 200, `status=${response?.status()}`);
    check(
      'A7 正文 contentHtml 渲染（h2 + ul + blockquote）',
      html.includes('What to check before you buy') &&
        html.includes('Thickness tolerance and density range') &&
        html.includes('Write the tolerance down before production'),
    );
    check('A7 .blog-prose 排版容器存在', prose > 0, `count=${prose}`);
    check(
      'A7 XSS 载荷未进入页面（无 xss-probe / alert 注入）',
      !html.includes('xss-probe') && !html.includes('<script>alert'),
    );
    await page.screenshot({ path: path.join(SHOT_DIR, 'blog-detail.png') });
  }

  // A10 移动端无横向溢出
  for (const viewport of [
    { width: 375, height: 812, label: '375' },
    { width: 390, height: 844, label: '390' },
    { width: 768, height: 1024, label: '768' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const url of ['/', '/about', `/blog/${POST_SLUG}`]) {
      await page.goto(`${UI}${url}`, { waitUntil: 'load', timeout: 45000 });
      const size = await horizontalOverflow(page);
      check(
        `A10 ${viewport.label}px ${url} 无横向溢出`,
        size.scrollWidth <= size.clientWidth + 1,
        `scrollWidth=${size.scrollWidth} clientWidth=${size.clientWidth}`,
      );
    }
    if (viewport.label === '390') {
      await page.screenshot({ path: path.join(SHOT_DIR, 'home-mobile-390.png'), fullPage: false });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ---------------- B. 后台 ----------------
  await page.goto(`${ADMIN}/login`, { waitUntil: 'load', timeout: 45000 });
  await page.fill('#email', 'admin@bailingwooden.com');
  await page.fill('#password', '123456789');
  await page.waitForTimeout(800); // 等 React hydrate，避免退化为原生 GET 提交
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForTimeout(2500);
  check('B1 后台登录成功（离开登录页）', !page.url().includes('/login'), `url=${page.url()}`);

  await page.goto(`${ADMIN}/site-content`, { waitUntil: 'load', timeout: 45000 });
  const listHtml = await page.content();
  check(
    'B2 站点内容列表渲染（中文界面 + 分区键 + 状态徽章）',
    listHtml.includes('home.hero') && listHtml.includes('about.hero') && listHtml.includes('已发布'),
  );
  await page.screenshot({ path: path.join(SHOT_DIR, 'admin-site-content.png') });

  // B3 编辑 home.hero 标题并保存
  let uiEditOk = false;
  try {
    const row = page.locator('tr', { hasText: 'home.hero' }).first();
    await row.getByRole('button', { name: '编辑' }).click();
    await page.waitForSelector('#section-title', { state: 'visible', timeout: 8000 });
    await page.fill('#section-title', MARK);
    await page.getByRole('button', { name: /保\s*存/ }).click();
    await page.waitForTimeout(3500);
    const afterHtml = await page.content();
    uiEditOk = afterHtml.includes(MARK);
    check('B3 后台保存 home.hero 标题成功（列表回显新值）', uiEditOk);
  } catch (error) {
    check('B3 后台保存 home.hero 标题成功（列表回显新值）', false, String(error).slice(0, 160));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, 'admin-site-content-after-save.png') });

  await page.goto(`${ADMIN}/navigation`, { waitUntil: 'load', timeout: 45000 });
  const navHtml = await page.content();
  check(
    'B4 导航管理页渲染（页眉 / 页脚分组 + 中文界面）',
    navHtml.includes('页眉') || navHtml.includes('HEADER'),
  );
  await page.screenshot({ path: path.join(SHOT_DIR, 'admin-navigation.png') });

  // ---------------- C. 链路闭环（ISR 300s 内前台自动更新） ----------------
  if (uiEditOk) {
    let seen = false;
    let waited = 0;
    const limitMs = 8 * 60 * 1000;
    while (waited < limitMs && !seen) {
      await page.waitForTimeout(20000);
      waited += 20000;
      const res = await fetch(`${UI}/`, { cache: 'no-store' });
      const html = await res.text();
      seen = html.includes(MARK);
      if (seen) break;
    }
    check(
      'C1 后台保存 → 前台首页在 ISR 窗口内自动更新',
      seen,
      `等待 ${Math.round(waited / 1000)}s`,
    );
    if (seen) {
      // 截图必须回到前台页面（此时浏览器仍停在后台导航页）
      await page.goto(`${UI}/`, { waitUntil: 'load', timeout: 45000 });
      await page.screenshot({ path: path.join(SHOT_DIR, 'home-after-admin-save.png') });
    }
  } else {
    check('C1 后台保存 → 前台首页在 ISR 窗口内自动更新', false, '后台保存步骤未成功，跳过');
  }

  // ---------------- D. 收尾 ----------------
  const token = await login();
  let restored = false;
  if (token) {
    const list = await api('GET', '/cms/site/sections?page=HOME', null, token);
    const hero = list.body?.data?.items?.find((item) => item.sectionKey === 'home.hero');
    if (hero) {
      const res = await api('PATCH', `/cms/site/sections/${hero.id}`, { title: 'Bailing Wooden' }, token);
      restored = res.status < 300;
    }
  }
  check('D1 首页 hero 标题已还原为 "Bailing Wooden"', restored);

  check('A11 全程无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();

  const passed = results.filter((item) => item.ok).length;
  console.log('='.repeat(78));
  console.log(`浏览器验证结果：${passed}/${results.length} 通过`);
  for (const item of results.filter((entry) => !entry.ok)) {
    console.log(`  FAIL: ${item.name} ${item.detail}`);
  }
  console.log(`截图目录：${SHOT_DIR}`);
  console.log('='.repeat(78));
  return passed === results.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('浏览器验证脚本异常：', error);
    process.exit(2);
  });
