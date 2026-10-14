/* Phase 4.2 Products CMS 运行时验证：登录 / 路由保护 / 页面渲染 / CMS API 全流程 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ADMIN = 'http://127.0.0.1:3001';
const API = 'http://127.0.0.1:4000/api/v1';
const UPLOADS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../uploads/products',
);

// 凭据从 bailing-backend/.env 读取（不硬编码）
const envPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.env',
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

const RUN_ID = Date.now().toString(36);
const CAT_SLUG = `verify-${RUN_ID}-cat`;
const PRODUCT_SLUG = `verify-${RUN_ID}-prod`;
const KEYWORD = `verify-kw-${RUN_ID}`;

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

/** 合法 PNG 魔数 + 填充字节（服务端魔数校验必须通过） */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
]);

async function backendLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const json = await res.json().catch(() => null);
  if (res.status !== 200 || !json?.data?.accessToken) {
    throw new Error(`后端登录失败: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.data.accessToken;
}

async function main() {
  /* ------------------------- 1. 登录页与路由保护 ------------------------- */
  const loginPage = await fetch(`${ADMIN}/login`, { redirect: 'manual' });
  check('GET /login 返回 200', loginPage.status === 200, `status=${loginPage.status}`);

  const noAuth = await fetch(`${ADMIN}/products`, { redirect: 'manual' });
  const location = noAuth.headers.get('location') ?? '';
  check(
    '未登录 GET /products → 重定向登录页（middleware 保护新路由）',
    noAuth.status >= 300 && noAuth.status < 400 && location.startsWith('/login'),
    `${noAuth.status} ${location}`,
  );

  const noAuthCat = await fetch(`${ADMIN}/categories`, { redirect: 'manual' });
  check(
    '未登录 GET /categories → 重定向登录页',
    (noAuthCat.headers.get('location') ?? '').startsWith('/login'),
    String(noAuthCat.status),
  );

  /* ------------------------- 2. 登录流程 ------------------------- */
  const badLogin = await fetch(`${ADMIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: 'wrong-password' }),
  });
  check('错误口令登录 → 401', badLogin.status === 401, `status=${badLogin.status}`);

  const goodLogin = await fetch(`${ADMIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  check('正确凭证登录 → 200', goodLogin.status === 200, `status=${goodLogin.status}`);

  const setCookie = goodLogin.headers.get('set-cookie') ?? '';
  check(
    '设置 admin_session Cookie（HttpOnly）',
    setCookie.includes('admin_session=') && /HttpOnly/i.test(setCookie),
    setCookie.slice(0, 120),
  );
  const cookie = setCookie.split(';')[0];
  const pageFetch = (url) => fetch(url, { headers: { Cookie: cookie }, redirect: 'manual' });

  /* ------------------------- 3. 页面渲染 ------------------------- */
  const productsPage = await pageFetch(`${ADMIN}/products`);
  const productsHtml = await productsPage.text();
  check('登录后 GET /products → 200', productsPage.status === 200, `status=${productsPage.status}`);
  check('产品页包含「产品管理」标题与新建按钮', productsHtml.includes('产品管理') && productsHtml.includes('新建产品'));

  const createPage = await pageFetch(`${ADMIN}/products/create`);
  const createHtml = await createPage.text();
  check('GET /products/create → 200', createPage.status === 200, `status=${createPage.status}`);
  check(
    '创建页包含核心表单字段（name/slug/categoryId/description）',
    ['name="name"', 'name="slug"', 'name="categoryId"', 'name="description"'].every((f) =>
      createHtml.includes(f),
    ),
  );

  const categoriesPage = await pageFetch(`${ADMIN}/categories`);
  const categoriesHtml = await categoriesPage.text();
  check('GET /categories → 200', categoriesPage.status === 200, `status=${categoriesPage.status}`);
  check('分类页包含「产品分类」标题', categoriesHtml.includes('产品分类'));

  /* ------------------------- 4. CMS API 全流程（JWT） ------------------------- */
  const token = await backendLogin();
  const api = (pathname, init = {}) => {
    // FormData 请求绝不能预设 Content-Type（会破坏 multipart boundary）
    const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
    return fetch(`${API}${pathname}`, {
      ...init,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  };

  // 分类 CRUD
  const catRes = await api('/cms/product-categories', {
    method: 'POST',
    body: JSON.stringify({ name: `Verify Cat ${RUN_ID}`, slug: CAT_SLUG }),
  });
  const catJson = await catRes.json();
  check('创建分类 → 201', catRes.status === 201, `status=${catRes.status}`);
  const categoryId = catJson?.data?.id;
  check('创建分类返回 id 与 productCount=0', Boolean(categoryId) && catJson?.data?.productCount === 0);

  // 分类页能看到新分类
  const catPageAfter = await pageFetch(`${ADMIN}/categories`);
  check(
    '分类页渲染新创建的分类',
    (await catPageAfter.text()).includes(`Verify Cat ${RUN_ID}`),
  );

  // 产品创建（DRAFT）
  const prodRes = await api('/cms/products', {
    method: 'POST',
    body: JSON.stringify({
      name: `Verify Product ${RUN_ID}`,
      slug: PRODUCT_SLUG,
      categoryId,
      description: `verify description ${KEYWORD}`,
      applications: ['Furniture'],
      specifications: { thickness: '18mm' },
    }),
  });
  const prodJson = await prodRes.json();
  check('创建产品 → 201 且默认 DRAFT', prodRes.status === 201 && prodJson?.data?.status === 'DRAFT', `status=${prodRes.status}`);
  const productId = prodJson?.data?.id;
  check('创建产品返回详情（含 applications/specifications）', Boolean(productId) && prodJson?.data?.applications?.[0] === 'Furniture', JSON.stringify(prodJson?.data?.applications));

  // 产品列表页渲染 + keyword 搜索
  const listPage = await pageFetch(`${ADMIN}/products?keyword=${encodeURIComponent(KEYWORD)}`);
  const listHtml = await listPage.text();
  check(
    '产品列表页 keyword 搜索命中新产品',
    listPage.status === 200 && listHtml.includes(`Verify Product ${RUN_ID}`),
    `status=${listPage.status}`,
  );

  // 编辑页渲染
  const editPage = await pageFetch(`${ADMIN}/products/${productId}/edit`);
  const editHtml = await editPage.text();
  check(
    'GET /products/[id]/edit → 200 且包含表单与图片管理',
    editPage.status === 200 && editHtml.includes('基本信息') && editHtml.includes('上传图片'),
    `status=${editPage.status}`,
  );

  // 更新产品（PATCH → PUBLISHED）
  const patchRes = await api(`/cms/products/${productId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'PUBLISHED', name: `Verify Product ${RUN_ID} v2` }),
  });
  const patchJson = await patchRes.json();
  check(
    'PATCH 更新产品 → 200（PUBLISHED + 改名）',
    patchRes.status === 200 && patchJson?.data?.status === 'PUBLISHED' && patchJson?.data?.name?.endsWith('v2'),
    `status=${patchRes.status}`,
  );

  // 图片上传（multipart，真 PNG 魔数）
  const form = new FormData();
  form.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'verify.png');
  form.append('alt', 'verify image');
  const uploadRes = await api(`/cms/products/${productId}/images`, { method: 'POST', body: form });
  const uploadJson = await uploadRes.json();
  check('上传图片 → 201 且首图默认主图', uploadRes.status === 201 && uploadJson?.data?.isPrimary === true, `status=${uploadRes.status}`);
  const imageId = uploadJson?.data?.id;
  const imageUrl = uploadJson?.data?.url ?? '';
  const imageFile = path.join(UPLOADS_DIR, imageUrl.split('/').pop() ?? '');
  check('图片真实落盘到 uploads/products', Boolean(imageUrl) && existsSync(imageFile), imageFile);

  // 伪造内容上传 → 400
  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('<html>x</html>')], { type: 'image/png' }), 'bad.png');
  const badUpload = await api(`/cms/products/${productId}/images`, { method: 'POST', body: badForm });
  check('伪造 MIME 上传 → 400', badUpload.status === 400, `status=${badUpload.status}`);

  // 删除图片
  const delImage = await api(`/cms/products/${productId}/images/${imageId}`, { method: 'DELETE' });
  check('删除图片 → 200', delImage.status === 200, `status=${delImage.status}`);
  check('图片文件已从磁盘清理', !existsSync(imageFile));

  // 删除产品 → 分类可删
  const delProduct = await api(`/cms/products/${productId}`, { method: 'DELETE' });
  check('删除产品 → 200', delProduct.status === 200, `status=${delProduct.status}`);

  const delCategory = await api(`/cms/product-categories/${categoryId}`, { method: 'DELETE' });
  check('删除分类 → 200', delCategory.status === 200, `status=${delCategory.status}`);

  /* ------------------------- 5. 登出 ------------------------- */
  const logout = await fetch(`${ADMIN}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  check('POST /api/auth/logout → 200', logout.status === 200, `status=${logout.status}`);
  const afterLogout = await fetch(`${ADMIN}/products`, { redirect: 'manual' });
  check(
    '登出后 GET /products → 重定向登录页',
    (afterLogout.headers.get('location') ?? '').startsWith('/login'),
    String(afterLogout.status),
  );

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验证脚本异常:', error);
  process.exit(1);
});
