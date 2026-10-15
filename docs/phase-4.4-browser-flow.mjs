/**
 * Phase 4.4 Blog CMS —— Admin 后台浏览器全流程验证（Playwright 直连，单会话）
 *
 * 覆盖：
 *   1  登录（HttpOnly Cookie 会话）
 *   2  侧边栏「博客管理」入口可点击（非 Coming Soon）
 *   3  文章列表页渲染（二级导航 / 新建入口）
 *   4  分类管理：新建 + 列表 + 状态列
 *   5  标签管理：新建 + 列表
 *   6  新建文章：标题/slug/摘要/富文本(含 XSS 载荷)/分类/标签/状态/SEO-OG-Twitter
 *   7  编辑页校验：状态、SEO 持久化、分类标签关联、发布时间自动填充、XSS 已过滤
 *   8  媒体库上传封面素材（真实可解码 PNG）
 *   9  从媒体库选择封面并保存
 *   10 列表页：封面缩略图真实加载 / 状态 / 分类 / 标签
 *   11 引用检查：被博客封面引用的媒体不可删除
 *   12 两步确认删除文章
 *   13 截图留档
 *
 * 用法：node docs/phase-4.4-browser-flow.mjs
 * 前置：postgres / backend:4000 / admin:3001 已启动；测试账号 pw-blog@bailingwooden.test 已入库
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright');

const ADMIN = 'http://127.0.0.1:3001';
const PW_EMAIL = 'pw-blog@bailingwooden.test';
const PW_PASSWORD = 'Pw-Blog-2026!';

const RUN = Date.now();
const CAT_NAME = `行业资讯-${RUN}`;
const CAT_SLUG = `pw-blog-cat-${RUN}`;
const TAG_NAME = `出口-${RUN}`;
const TAG_SLUG = `pw-blog-tag-${RUN}`;
const POST_TITLE = `板材出口指南 ${RUN}`;
const POST_SLUG = `pw-blog-post-${RUN}`;
const ORIGINAL = `pw-blog-cover-${RUN}.png`;
const PNG_DIR = process.env.TEMP || process.env.TMP || '.';
const PNG = path.join(PNG_DIR, ORIGINAL);
const SHOT_DIR = path.resolve('docs');

let passed = 0;
let failed = 0;
const info = (s) => console.log(`== ${s} ==`);
const pass = (s) => { passed++; console.log(`PASS  ${s}`); };
const fail = (s) => { failed++; console.log(`FAIL  ${s}`); };
const check = (ok, okMsg, failMsg) => (ok ? pass(okMsg) : fail(failMsg));

/* ---------------- 生成真实可解码 PNG（640x480 RGB） ---------------- */
function makePng(file) {
  const t = (() => { const a = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; a[n] = c >>> 0; } return a; })();
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const W = 640, H = 480;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(H * (1 + W * 3), 0);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, png);
}

/* ---------------- 数据预清理 / 末清理 ---------------- */
function psql(sql) {
  try { return execSync(`docker exec bailing-postgres psql -U bailing -d bailingwooden -t -A -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim(); } catch { return ''; }
}
function cleanup() {
  const keys = psql(`SELECT "storageKey" FROM media_assets WHERE "originalName" LIKE 'pw-blog-%';`);
  for (const k of keys.split('\n').filter(Boolean)) {
    try { fs.rmSync(path.resolve('/d/com.bailingwooden/bailing-backend/uploads/media', k.replace(/^media\//, '')), { force: true }); } catch {}
  }
  psql(`DELETE FROM blog_post_tags WHERE "postId" IN (SELECT id FROM blog_posts WHERE slug LIKE 'pw-blog-%');`);
  psql(`DELETE FROM blog_posts WHERE slug LIKE 'pw-blog-%';`);
  psql(`DELETE FROM blog_categories WHERE slug LIKE 'pw-blog-%';`);
  psql(`DELETE FROM blog_tags WHERE slug LIKE 'pw-blog-%';`);
  psql(`DELETE FROM media_assets WHERE "originalName" LIKE 'pw-blog-%';`);
}

/* ---------------- 主流程 ---------------- */
const main = async () => {
  makePng(PNG);
  cleanup();

  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

  const mainText = () => page.evaluate(() => document.querySelector('main')?.innerText ?? '');
  const waitText = async (needle, secs = 15) => {
    for (let i = 0; i < secs; i++) {
      if ((await mainText()).includes(needle)) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  };

  /* -------- 1. 登录 -------- */
  info('1. 登录');
  await page.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', PW_EMAIL);
  await page.fill('#password', PW_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard', { timeout: 20000 }).catch(() => {});
  check(page.url().endsWith('/dashboard'), '登录成功进入 /dashboard', `登录后 URL: ${page.url()}`);

  /* -------- 2. 侧边栏入口 -------- */
  info('2. 侧边栏「博客管理」入口');
  await page.goto(`${ADMIN}/dashboard`, { waitUntil: 'networkidle' });
  const linkText = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('aside a')).find((x) => x.getAttribute('href') === '/blog');
    return a ? a.innerText.replace(/\s+/g, ' ').trim() : 'nolink';
  });
  check(linkText.includes('博客管理'), `侧边栏 Blog 项可用（${linkText}）`, `侧边栏 Blog 项异常: ${linkText}`);

  /* -------- 3. 文章列表页 -------- */
  info('3. 文章列表页');
  await page.goto(`${ADMIN}/blog`, { waitUntil: 'networkidle' });
  let txt = await mainText();
  check(txt.includes('博客管理'), '/blog 页面渲染成功', '/blog 页面异常');
  check(txt.includes('文章列表'), '二级导航「文章列表」可见', '二级导航缺失');
  check(txt.includes('新建文章'), '「新建文章」入口可见', '「新建文章」入口缺失');

  /* -------- 4. 分类管理 -------- */
  info('4. 分类管理：新建分类');
  await page.goto(`${ADMIN}/blog/categories`, { waitUntil: 'networkidle' });
  await page.fill('#new-name', CAT_NAME);
  await page.fill('#new-slug', CAT_SLUG);
  await page.fill('#new-sortOrder', '3');
  await page.fill('#new-description', '行业资讯与趋势');
  await page.click('button:has-text("创建分类")');
  check(await waitText(CAT_NAME, 15), `分类创建成功并出现在列表：${CAT_NAME}`, '分类未出现在列表');
  txt = await mainText();
  check(txt.includes('启用'), '分类状态显示「启用」', '分类状态列异常');

  /* -------- 5. 标签管理 -------- */
  info('5. 标签管理：新建标签');
  await page.goto(`${ADMIN}/blog/tags`, { waitUntil: 'networkidle' });
  await page.fill('#new-tag-name', TAG_NAME);
  await page.fill('#new-tag-slug', TAG_SLUG);
  await page.click('button:has-text("创建标签")');
  check(await waitText(TAG_NAME, 15), `标签创建成功并出现在列表：${TAG_NAME}`, '标签未出现在列表');

  /* -------- 6. 新建文章 -------- */
  info('6. 新建文章（富文本 + 分类 + 标签 + 状态 + SEO）');
  await page.goto(`${ADMIN}/blog/create`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.fill('#title', POST_TITLE);
  await page.fill('#slug', POST_SLUG);
  await page.fill('#excerpt', '面向海外采购商的板材出口指南摘要');

  const XSS = '<h2>行业趋势</h2><p>板材出口保持增长，<strong>重点关注</strong>环保与可持续认证。</p>'
    + '<ul><li>CARB / E0 认证</li><li>FSC 森林认证</li></ul>'
    + '<script>alert(1)<\/script><img src="x" onerror="alert(1)">';
  await page.evaluate((html) => {
    const ed = document.querySelector('[contenteditable]');
    ed.focus();
    ed.innerHTML = html;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }, XSS);
  await page.waitForTimeout(600);
  const hidden = await page.evaluate(() => document.querySelector('input[name=content]')?.value ?? '');
  check(hidden.includes('行业趋势'), '富文本正文已同步到提交字段', `正文未同步: ${hidden.slice(0, 40)}`);

  const catOk = await page.evaluate((cn) => {
    const s = document.querySelector('#categoryId');
    if (!s) return 'nosel';
    const o = Array.from(s.options).find((x) => x.textContent.includes(cn));
    if (!o) return 'noopt';
    s.value = o.value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  }, CAT_NAME);
  check(catOk === 'ok', `已选择分类：${CAT_NAME}`, `分类选择失败: ${catOk}`);

  const tagOk = await page.evaluate((tn) => {
    const b = Array.from(document.querySelectorAll('button[aria-pressed]')).find((x) => x.textContent.trim() === tn);
    if (!b) return 'nobtn';
    b.click();
    return 'clicked';
  }, TAG_NAME);
  await page.waitForTimeout(500);
  const tagPressed = await page.evaluate((tn) => {
    const b = Array.from(document.querySelectorAll('button[aria-pressed]')).find((x) => x.textContent.trim() === tn);
    return b ? b.getAttribute('aria-pressed') : 'missing';
  }, TAG_NAME);
  check(tagOk === 'clicked' && tagPressed === 'true', `已选中标签：${TAG_NAME}`, `标签选择失败: ${tagOk}/${tagPressed}`);

  await page.selectOption('#status', 'PUBLISHED');
  check((await page.inputValue('#status')) === 'PUBLISHED', '状态已设为 PUBLISHED', '状态设置失败');

  await page.fill('#seoTitle', '板材出口指南 | 百灵木业');
  await page.fill('#seoDescription', '面向海外采购商的板材出口指南，涵盖认证与规格要点');
  await page.fill('#seoKeywords', 'plywood,export,guide');
  await page.fill('#canonicalUrl', `https://bailingwooden.com/blog/${POST_SLUG}`);
  await page.fill('#ogTitle', `OG 标题-${RUN}`);
  await page.fill('#ogDescription', `OG 描述-${RUN}`);
  await page.fill('#ogImage', `https://bailingwooden.com/og-${RUN}.png`);
  await page.fill('#twitterTitle', `TW 标题-${RUN}`);
  await page.fill('#twitterDescription', `TW 描述-${RUN}`);
  pass('SEO / OG / Twitter 字段填写完成');

  await page.click('button:has-text("创建文章")');
  let POST_ID = '';
  for (let i = 0; i < 20; i++) {
    const m = page.url().match(/\/blog\/([^/]+)\/edit$/);
    if (m) { POST_ID = m[1]; break; }
    await page.waitForTimeout(1000);
  }
  check(!!POST_ID, `创建成功并跳转编辑页（id=${POST_ID}）`, '创建后未跳转编辑页');

  /* -------- 7. 编辑页校验 -------- */
  info('7. 编辑页校验（持久化 + XSS 过滤 + 发布时间）');
  await page.waitForTimeout(2000);
  txt = await mainText();
  check(txt.includes('已发布'), '状态显示「已发布」', '状态未显示已发布');

  // SEO / OG / Twitter 为 <input>，值不在 innerText 中，须读 input.value
  const seoVals = await page.evaluate(() => ({
    seoTitle: document.querySelector('#seoTitle')?.value ?? '',
    seoKeywords: document.querySelector('#seoKeywords')?.value ?? '',
    ogTitle: document.querySelector('#ogTitle')?.value ?? '',
    twitterTitle: document.querySelector('#twitterTitle')?.value ?? '',
  }));
  check(seoVals.seoTitle === '板材出口指南 | 百灵木业', `SEO 标题已持久化（${seoVals.seoTitle}）`, `SEO 标题未持久化: ${seoVals.seoTitle}`);
  check(seoVals.seoKeywords === 'plywood,export,guide', `SEO 关键词已持久化（${seoVals.seoKeywords}）`, `SEO 关键词未持久化: ${seoVals.seoKeywords}`);
  check(seoVals.ogTitle === `OG 标题-${RUN}`, `OG 标题已持久化（预留字段可用：${seoVals.ogTitle}）`, `OG 标题未持久化: ${seoVals.ogTitle}`);
  check(seoVals.twitterTitle === `TW 标题-${RUN}`, `Twitter 标题已持久化（预留字段可用：${seoVals.twitterTitle}）`, `Twitter 标题未持久化: ${seoVals.twitterTitle}`);

  check(txt.includes(CAT_NAME), `分类关联正确（${CAT_NAME}）`, '分类关联缺失');
  check(txt.includes(TAG_NAME), `标签关联正确（${TAG_NAME}）`, '标签关联缺失');

  const pub = await page.evaluate(() => document.querySelector('#publishedAt')?.value ?? '');
  check(!!pub, `发布时间已自动填充：${pub}`, '发布时间未自动填充');

  const bodyHtml = await page.evaluate(() => document.querySelector('[contenteditable]')?.innerHTML ?? '');
  if (bodyHtml.includes('<script')) fail('正文仍含 <script>（XSS 过滤失效）');
  else if (/onerror/i.test(bodyHtml)) fail('正文仍含 onerror（XSS 过滤失效）');
  else if (bodyHtml.includes('行业趋势')) pass('正文已保存且不安全标签被过滤');
  else fail(`正文内容异常: ${bodyHtml.slice(0, 120)}`);

  /* -------- 8. 媒体库上传 -------- */
  info('8. 媒体库上传封面素材');
  await page.goto(`${ADMIN}/media`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(PNG);
  check(await waitText(ORIGINAL, 25), `媒体上传成功：${ORIGINAL}`, '媒体上传后未见卡片');

  /* -------- 9. 选择封面 -------- */
  info('9. 从媒体库选择封面');
  await page.goto(`${ADMIN}/blog/${POST_ID}/edit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.click('button:has-text("从媒体库选择封面")');
  let dlg = '';
  for (let i = 0; i < 15; i++) {
    dlg = await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.slice(0, 100) ?? 'nodialog');
    if (dlg !== 'nodialog') break;
    await page.waitForTimeout(1000);
  }
  check(dlg.includes('从媒体库选择图片'), '封面选择弹窗已打开', `封面弹窗未打开: ${dlg}`);

  // 弹窗打开后媒体列表为异步加载：必须等目标卡片真正渲染出来再点击
  let pickReady = false;
  for (let i = 0; i < 20; i++) {
    pickReady = await page.evaluate((fn) => {
      const d = document.querySelector('[role=dialog]');
      if (!d) return false;
      return Array.from(d.querySelectorAll('button')).some((x) => x.innerText.includes(fn));
    }, ORIGINAL);
    if (pickReady) break;
    await page.waitForTimeout(1000);
  }

  const picked = await page.evaluate((fn) => {
    const d = document.querySelector('[role=dialog]');
    if (!d) return 'nodialog';
    const b = Array.from(d.querySelectorAll('button')).find((x) => x.innerText.includes(fn));
    if (!b) return 'nopick';
    b.click();
    return 'picked';
  }, ORIGINAL);
  check(picked === 'picked', `已在弹窗中选中封面：${ORIGINAL}`, `封面选择失败: ${picked}（列表项已就绪=${pickReady}）`);
  await page.waitForTimeout(1500);

  // 确认弹窗已关闭，避免遮挡后续保存按钮
  const dlgGone = await page.evaluate(() => !document.querySelector('[role=dialog]'));
  check(dlgGone, '选择后弹窗已自动关闭', '选择后弹窗未关闭');

  const coverId = await page.evaluate(() => document.querySelector('input[name=coverMediaId]')?.value ?? '');
  check(!!coverId, `coverMediaId 已写入（${coverId}）`, 'coverMediaId 未写入');

  await page.click('button:has-text("保存修改")');
  check(await waitText('已保存', 20), '封面保存成功（页面提示「已保存」）', '封面保存未出现成功提示');

  /* -------- 10. 列表页校验 -------- */
  info('10. 列表页校验（封面缩略图 / 状态 / 分类 / 标签）');
  await page.goto(`${ADMIN}/blog`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  check(await waitText(POST_TITLE, 12), `文章出现在列表：${POST_TITLE}`, '文章未出现在列表');
  txt = await mainText();
  check(txt.includes('已发布'), '列表状态显示「已发布」', '列表状态异常');
  check(txt.includes(CAT_NAME), '列表显示分类', '列表缺分类');
  check(txt.includes(TAG_NAME), '列表显示标签', '列表缺标签');

  let thumb = 'noimg';
  for (let i = 0; i < 15; i++) {
    thumb = await page.evaluate(() => {
      const hit = Array.from(document.querySelectorAll('main img')).find((x) => (x.getAttribute('src') || '').includes('/uploads/media/'));
      if (!hit) return 'noimg';
      return hit.complete && hit.naturalWidth ? `${hit.naturalWidth}x${hit.naturalHeight}` : 'loading';
    });
    if (thumb === '640x480') break;
    await page.waitForTimeout(1000);
  }
  check(thumb === '640x480', '列表封面缩略图真实加载（naturalWidth 640）', `列表封面缩略图异常: ${thumb}`);

  /* -------- 11. 引用检查 -------- */
  info('11. 引用检查：被博客封面引用的媒体不可删除');
  await page.goto(`${ADMIN}/media`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.evaluate((fn) => {
    const card = Array.from(document.querySelectorAll('li')).find((li) => li.innerText.includes(fn));
    const btn = card && Array.from(card.querySelectorAll('button')).find((b) => b.innerText.trim() === '删除');
    btn?.click();
  }, ORIGINAL);
  await page.waitForTimeout(1000);
  await page.evaluate((fn) => {
    const card = Array.from(document.querySelectorAll('li')).find((li) => li.innerText.includes(fn));
    const btn = card && Array.from(card.querySelectorAll('button')).find((b) => b.innerText.trim() === '确认删除');
    btn?.click();
  }, ORIGINAL);
  await page.waitForTimeout(3000);
  const err = await page.evaluate(() => document.querySelector('li [role=alert]')?.innerText ?? 'noalert');
  check(err.includes('引用'), `删除被拒并给出中文提示：${err}`, `引用检查提示异常: ${err}`);
  const still = await page.evaluate((fn) => (document.querySelector('main')?.innerText ?? '').includes(fn) ? 'present' : 'gone', ORIGINAL);
  check(still === 'present', '媒体仍在库中（未被误删）', '媒体被误删');

  /* -------- 12. 删除文章 -------- */
  info('12. 删除文章（两步确认）');
  await page.goto(`${ADMIN}/blog`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.evaluate((t) => {
    const row = Array.from(document.querySelectorAll('tr')).find((r) => r.innerText.includes(t));
    const btn = row && Array.from(row.querySelectorAll('button')).find((b) => b.innerText.trim() === '删除');
    btn?.click();
  }, POST_TITLE);
  await page.waitForTimeout(1000);
  await page.evaluate((t) => {
    const row = Array.from(document.querySelectorAll('tr')).find((r) => r.innerText.includes(t));
    const btn = row && Array.from(row.querySelectorAll('button')).find((b) => b.innerText.trim() === '确认');
    btn?.click();
  }, POST_TITLE);
  await page.waitForTimeout(4000);
  txt = await mainText();
  check(!txt.includes(POST_TITLE), '两步删除成功，文章已从列表移除', '删除后文章仍在列表');

  /* -------- 13. 截图 -------- */
  info('13. 截图留档');
  const shot = path.join(SHOT_DIR, 'phase-4.4-blog-list.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`SCREENSHOT  ${shot}`);

  const realErrors = consoleErrors.filter((e) => !/404|Failed to load resource/i.test(e));
  if (pageErrors.length) console.log('PAGE ERRORS:\n' + pageErrors.slice(0, 5).join('\n'));
  if (realErrors.length) console.log('CONSOLE ERRORS:\n' + realErrors.slice(0, 5).join('\n'));
  check(pageErrors.length === 0, '全程无未捕获页面异常', `存在页面异常 ${pageErrors.length} 条`);

  await browser.close();
  fs.rmSync(PNG, { force: true });
  cleanup();

  console.log('');
  console.log(`===== Phase 4.4 博客 CMS 浏览器流程结束：PASS ${passed} / FAIL ${failed} =====`);
  process.exit(failed > 0 ? 1 : 0);
};

main().catch((e) => { console.error('FATAL', e); try { cleanup(); } catch {} process.exit(2); });
