/**
 * 访客统计浏览器验收（实现规格 12.5 前端条款 —— admin 侧 14 条）。
 *
 * 前置：
 *   · 后端 4000、admin 3011 已启动；
 *   · scripts/visitor-acceptance-setup.mjs 已执行（账号与夹具）。
 *
 * 运行（Git Bash）：
 *   NODE_PATH=C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules \
 *   node docs/visitor-admin-acceptance.mjs
 */
import { createRequire } from 'node:module';

// ESM 下 NODE_PATH 无效，改为从受管 node workspace 显式解析 playwright-core
const workspaceRequire = createRequire(
  'C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/',
);
const { chromium } = workspaceRequire('playwright-core');

const ADMIN = 'http://127.0.0.1:3011';
const BACKEND = 'http://127.0.0.1:4000/api/v1';
const SUPER = 'visitor-super@bailingwooden.test';
const VIEWER = 'visitor-viewer@bailingwooden.test';
const PASS = 'E2E-pass-2026!';

const results = [];
let page;
let ctx;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

async function login(email) {
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  await page.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASS);
  await Promise.all([
    page.waitForURL(/dashboard/, { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState('networkidle');
}

/** 只取卡片中的数值元素（text-heading-lg），避免把 hint 里的数字混进来 */
const textOf = async (testid) =>
  (
    await page
      .locator(`[data-testid="${testid}"]`)
      .first()
      .locator('.text-heading-lg')
      .innerText()
  ).trim();
const num = (s) => Number(s.replace(/[^\d]/g, ''));

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--no-proxy-server'],
});

try {
  // ---------- 超管：dashboard ----------
  await login(SUPER);
  check('1. 超管登录成功进入 dashboard', page.url().includes('/dashboard'));

  await page.locator('[data-testid="visitor-overview"]').waitFor({ timeout: 15000 });
  check('2. 访客概览区块渲染（visitor-overview）', true);

  const cards = [
    'visitor-card-today-visitors',
    'visitor-card-today-visits',
    'visitor-card-last-7-visitors',
    'visitor-card-last-30-visitors',
  ];
  const values = {};
  for (const id of cards) {
    const t = await textOf(id);
    values[id] = num(t);
    check(`3. 卡片渲染且为数字：${id}=${values[id]}`, Number.isFinite(values[id]));
  }

  check(
    '6. 区间单调：今日 ≤ 7日 ≤ 30日',
    values['visitor-card-today-visitors'] <= values['visitor-card-last-7-visitors'] &&
      values['visitor-card-last-7-visitors'] <= values['visitor-card-last-30-visitors'],
  );

  const chart = page.locator('[data-testid="visitor-trend-chart"] svg');
  await chart.waitFor({ timeout: 5000 });
  const dotCount = await page.locator('[data-testid="visitor-trend-chart"] circle').count();
  check('7. 趋势图 SVG 渲染（含数据点 circle）', (await chart.count()) === 1 && dotCount > 0, `${dotCount} 个点`);

  // 8. 趋势末点（今日）UV == 今日访客卡（今日恒实时，两处数字一致）
  const todayCard = values['visitor-card-today-visitors'];
  // 每个日期点有两个 circle（UV/PV），UV 的 title 才含「独立访客」
  const uvTitles = await page
    .locator('[data-testid="visitor-trend-chart"] circle title')
    .allTextContents();
  const todayPointUv = Number(
    /独立访客 (\d+)/.exec([...uvTitles].reverse().find((t) => t.includes('独立访客')) ?? '')?.[1] ?? NaN,
  );
  check('8. 趋势图今日点 UV 与今日访客卡一致（今日恒实时）', todayPointUv === todayCard, `图 ${todayPointUv} vs 卡 ${todayCard}`);

  // 9. 切换 30 日
  await page.click('[data-testid="visitor-trend-days-30"]');
  await page.waitForURL(/days=30/);
  await page.waitForLoadState('networkidle');
  const chart30 = await page.locator('[data-testid="visitor-trend-chart"] svg').count();
  check('9. 切换 30 日：URL 带 days=30 且图表仍渲染', chart30 === 1);

  // 10. 实时性：上报一位全新访客 → 刷新后今日访客 +1
  const before = num(await textOf('visitor-card-today-visitors'));
  const trackRes = await fetch(`${BACKEND}/visitor/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId: crypto.randomUUID() }),
  });
  if (!trackRes.ok) throw new Error(`track 失败 ${trackRes.status}`);
  await page.goto(`${ADMIN}/dashboard?days=7`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="visitor-card-today-visitors"]').waitFor();
  const after = num(await textOf('visitor-card-today-visitors'));
  check('10. 今日实时查事实源：新访客上报后今日访客 +1', after === before + 1, `${before} → ${after}`);

  // 11. viewer（仅 visitor_stats.read）：dashboard 访客概览仍渲染
  await ctx.close();
  await login(VIEWER);
  let viewerBlock = 0;
  try {
    await page.locator('[data-testid="visitor-overview"]').waitFor({ timeout: 8000 });
    viewerBlock = 1;
  } catch {
    const body = (await page.locator('body').innerText()).slice(0, 400);
    check('11 诊断', false, `URL=${page.url()} BODY=${body.replace(/\n/g, ' ')}`);
  }
  check('11. 仅 visitor_stats.read 的账号可见访客概览', viewerBlock === 1);

  // 12. viewer /visitor-records → 整页禁止提示，无表格、无请求成果
  await page.goto(`${ADMIN}/visitor-records`, { waitUntil: 'networkidle' });
  const forbidden = await page.locator('[data-testid="visitor-records-forbidden"]').count();
  const table = await page.locator('[data-testid="visitor-records-table"]').count();
  check('12. 无 visitor_records.read：显示禁止提示且无表格', forbidden === 1 && table === 0);

  // ---------- 超管：visitor-records ----------
  await ctx.close();
  await login(SUPER);
  await page.goto(`${ADMIN}/visitor-records?period=day&page=1`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="visitor-records-table"]').waitFor({ timeout: 10000 });

  const headers = await page.locator('[data-testid="visitor-records-table"] th').allInnerTexts();
  check(
    '13. 记录表恰 4 列：IP（网段）/ 国家 / 城市 / 访问时间',
    JSON.stringify(headers.map((h) => h.trim())) ===
      JSON.stringify(['IP（网段）', '国家', '城市', '访问时间']),
    headers.join(' | '),
  );

  const firstIp = (
    await page.locator('[data-testid="visitor-records-table"] tbody tr').first().locator('td').first().innerText()
  ).trim();
  check(
    '14. maskedIp 为脱敏网段格式（x.x.x.0/24），无完整 IP',
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24$/.test(firstIp),
    firstIp,
  );

  // 附加：周期 tab 切换
  await page.click('[data-testid="visitor-records-period-week"]');
  await page.waitForURL(/period=week/);
  await page.waitForLoadState('networkidle');
  check(
    '15. 周期 tab 切换正常（week）',
    (await page.locator('[data-testid="visitor-records-table"]').count()) === 1,
  );
} catch (err) {
  check('意外异常', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== 浏览器验收：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
