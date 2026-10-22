/**
 * Phase 5.4.4 - 浏览器只读验收（前台 + 图片加载 + 移动端）。
 * 运行：NODE_PATH=<workspace node_modules> node phase54-browser-acceptance.mjs
 * 只做导航与截图/断言，不进行任何写操作。
 */
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/');
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:3000';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

async function checkPage(ctx, url, name, opts = {}) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2000); // hydration + 懒加载
    record(`${name} HTTP`, resp?.ok() ?? false, `status=${resp?.status()} url=${url}`);
    if (opts.expectImage) {
      // hydration 期间 DOM 可能重渲染，轮询直到检测到媒体图或超时
      let media = [];
      let loaded = [];
      for (let i = 0; i < 6 && media.length === 0; i++) {
        await page.waitForTimeout(1500);
        const imgs = await page.$$eval('img', (els) =>
          els.map((e) => {
            let src = e.currentSrc || e.src || '';
            try {
              src = decodeURIComponent(src);
            } catch { /* keep raw */ }
            return { src, w: e.naturalWidth, h: e.naturalHeight };
          }),
        );
        media = imgs.filter((i) => i.src.includes('/uploads/media/'));
        // 判定标准：已开始加载(complete)的迁移图全部解码成功；懒加载未触发不算失败
        const broken = await page.$$eval('img', (els) =>
          els.filter((e) => {
            let s = e.currentSrc || e.src || '';
            try { s = decodeURIComponent(s); } catch { /* keep raw */ }
            return s.includes('/uploads/media/') && e.complete && e.naturalWidth === 0;
          }).length,
        );
        loaded = media.length - broken;
      }
      record(`${name} 迁移图片加载`, media.length > 0 && loaded === media.length,
        `迁移图 ${loaded}/${media.length} 加载成功（无加载失败）`);
    }
    if (opts.expectText) {
      const body = await page.content();
      record(`${name} 内容检查`, body.includes(opts.expectText), `包含 "${opts.expectText}"`);
    }
    if (opts.screenshot) {
      await page.screenshot({ path: opts.screenshot, fullPage: false });
    }
  } catch (e) {
    record(`${name} 异常`, false, String(e).slice(0, 150));
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    // 桌面端
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await checkPage(desktop, `${BASE}/`, '首页', { screenshot: 'shot-home-desktop.png' });
    await checkPage(desktop, `${BASE}/products`, '产品列表', { screenshot: 'shot-products-desktop.png' });
    await checkPage(desktop, `${BASE}/products/melamine-mdf`, '产品详情(melamine-mdf)',
      { expectImage: true, screenshot: 'shot-product-desktop.png' });
    await checkPage(desktop, `${BASE}/products/pet-mdf`, '产品详情(pet-mdf)', { expectImage: true });
    await checkPage(desktop, `${BASE}/blog`, '文章列表', { screenshot: 'shot-blog-desktop.png' });
    await checkPage(desktop, `${BASE}/blog/the-role-of-film-faced-plywood-in-reducing-concrete-construction-costs`,
      '文章详情', { expectImage: true, screenshot: 'shot-post-desktop.png' });
    await desktop.close();

    // 移动端
    const mobile = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true });
    await checkPage(mobile, `${BASE}/products/melamine-mdf`, '移动端·产品详情', { expectImage: true, screenshot: 'shot-product-mobile.png' });
    await checkPage(mobile, `${BASE}/blog/the-role-of-film-faced-plywood-in-reducing-concrete-construction-costs`,
      '移动端·文章详情', { expectImage: true, screenshot: 'shot-post-mobile.png' });
    await mobile.close();

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n=== 浏览器验收: ${checks.length - failed.length}/${checks.length} PASS ===`);
    if (failed.length > 0) process.exit(2);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
