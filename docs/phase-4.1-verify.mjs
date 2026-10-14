/* Phase 4.1 Admin 运行时验证：登录 / 路由保护 / Dashboard / 登出 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ADMIN = 'http://127.0.0.1:3001';

// 凭据从 bailing-backend/.env 读取（不硬编码在脚本中）
const envPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bailing-backend/.env',
);
function readEnv(key, fallback = '') {
  const match = readFileSync(envPath, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : fallback;
}
const EMAIL = readEnv('ADMIN_EMAIL', 'admin@bailingwooden.com');
const PASSWORD = readEnv('ADMIN_PASSWORD');
if (!PASSWORD) {
  console.error('未在 bailing-backend/.env 中找到 ADMIN_PASSWORD');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

async function main() {
  // 1. 登录页可访问且包含表单
  const loginPage = await fetch(`${ADMIN}/login`, { redirect: 'manual' });
  const loginHtml = await loginPage.text();
  check('GET /login 返回 200', loginPage.status === 200, `status=${loginPage.status}`);
  check('登录页包含 Email/Password 输入', loginHtml.includes('id="email"') && loginHtml.includes('id="password"'));

  // 2. 未登录访问 /dashboard → 重定向 /login?next=/dashboard
  const noAuth = await fetch(`${ADMIN}/dashboard`, { redirect: 'manual' });
  const location = noAuth.headers.get('location') ?? '';
  check('未登录 GET /dashboard → 307 到登录页', noAuth.status >= 300 && noAuth.status < 400 && location.startsWith('/login'), `${noAuth.status} ${location}`);
  check('重定向携带 next=/dashboard', location.includes('next=%2Fdashboard') || location.includes('next=/dashboard'), location);

  // 3. 未登录访问 /rfq 同样被拦截
  const noAuthRfq = await fetch(`${ADMIN}/rfq`, { redirect: 'manual' });
  check('未登录 GET /rfq → 重定向登录页', (noAuthRfq.headers.get('location') ?? '').startsWith('/login'), String(noAuthRfq.status));

  // 4. 错误口令 → 401 且文案为 Invalid email or password
  const badLogin = await fetch(`${ADMIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: 'wrong-password' }),
  });
  const badJson = await badLogin.json().catch(() => null);
  check('错误口令登录 → 401', badLogin.status === 401, `status=${badLogin.status}`);
  check('失败文案 Invalid email or password', badJson?.error === 'Invalid email or password', JSON.stringify(badJson));

  // 5. 不存在邮箱 → 同一 401 文案（防账号枚举）
  const ghostLogin = await fetch(`${ADMIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ghost@bailingwooden.test', password: 'whatever12' }),
  });
  const ghostJson = await ghostLogin.json().catch(() => null);
  check('不存在邮箱登录 → 401 同一文案', ghostLogin.status === 401 && ghostJson?.error === 'Invalid email or password', JSON.stringify(ghostJson));

  // 6. 正确凭证 → 200 + HttpOnly Cookie
  const goodLogin = await fetch(`${ADMIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  check('正确凭证登录 → 200', goodLogin.status === 200, `status=${goodLogin.status}`);
  const setCookie = goodLogin.headers.get('set-cookie') ?? '';
  check('设置 admin_session Cookie（HttpOnly）', setCookie.includes('admin_session=') && /HttpOnly/i.test(setCookie), setCookie.slice(0, 120));

  const cookie = setCookie.split(';')[0];
  const auth = { headers: { Cookie: cookie }, redirect: 'manual' };

  // 7. 带 Cookie 访问 /dashboard → 200 且包含真实统计
  const dash = await fetch(`${ADMIN}/dashboard`, auth);
  const dashHtml = await dash.text();
  check('登录后 GET /dashboard → 200', dash.status === 200, `status=${dash.status}`);
  check('Dashboard 包含统计卡片标题', dashHtml.includes('RFQ 询盘总数') && dashHtml.includes('新询盘'));
  check('Dashboard 包含当前用户邮箱', dashHtml.includes(EMAIL));

  // 8. 带 Cookie 访问 /rfq → 200（既有页面不受破坏）
  const rfq = await fetch(`${ADMIN}/rfq`, auth);
  check('登录后 GET /rfq → 200', rfq.status === 200, `status=${rfq.status}`);

  // 9. 伪造 Cookie → /dashboard 页面级鉴权拒绝并重定向
  const forged = await fetch(`${ADMIN}/dashboard`, { redirect: 'manual', Cookie: 'admin_session=forged.token.value' });
  check('伪造 Cookie 访问 /dashboard → 重定向登录页', (forged.headers.get('location') ?? '').startsWith('/login'), `${forged.status} ${forged.headers.get('location')}`);

  // 10. 登出 → Cookie 清除，随后 /dashboard 回到登录页
  const logout = await fetch(`${ADMIN}/api/auth/logout`, { method: 'POST', Cookie: cookie });
  check('POST /api/auth/logout → 200', logout.status === 200, `status=${logout.status}`);
  const afterLogout = await fetch(`${ADMIN}/dashboard`, { redirect: 'manual' });
  check('登出后 /dashboard → 重定向登录页', (afterLogout.headers.get('location') ?? '').startsWith('/login'), String(afterLogout.status));

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验证脚本异常:', error);
  process.exit(1);
});
