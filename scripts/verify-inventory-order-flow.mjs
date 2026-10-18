/**
 * Phase 5.3 管理端真实联调验证（一次性脚本）。
 *
 * 目的：在真实 HTTP 服务（admin 3001 + backend 4000）上验证
 * 库存管理 + 订单号规范化的完整链路，而非只跑后端 API：
 *   1. 临时创建 SUPER_ADMIN / SALES ×2 账号（bcrypt 低成本哈希，与 e2e 同手法）；
 *   2. 经管理后台 /api/auth/login 登录拿 HttpOnly Cookie；
 *   3. 订单号规范化：手动填写创建、重复 409、精确查询、筛选叠加、
 *      越权搜索他人订单号查不到、编辑不接受订单号字段；
 *   4. 库存：从订单创建（自动关联+订单号带入）、独立创建（不关联）、
 *      越权读写删 403/404、伪造订单关联 403、编辑字段白名单、
 *      负数量拒绝、删除不影响订单；
 *   5. 页面渲染：/orders、/inventory、/orders/[id]（关联库存卡）、
 *      /inventory/new?orderId=（订单锁定表单）、未登录 307/401；
 *   6. 清理：库存、订单、临时账号（finally 保证执行）。
 *
 * 运行：node scripts/verify-inventory-order-flow.mjs
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const ADMIN_BASE = process.env.ADMIN_BASE ?? 'http://127.0.0.1:3001';
const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000/api/v1';
const PASSWORD = 'Verify-pass-2026!';
const RUN_ID = Date.now().toString(36);
const PREFIX = 'verify-inv';

const ADMIN_EMAIL = `${PREFIX}-admin-${RUN_ID}@bailingwooden.test`;
const SALES_EMAIL = `${PREFIX}-sales-${RUN_ID}@bailingwooden.test`;
const OTHER_EMAIL = `${PREFIX}-other-${RUN_ID}@bailingwooden.test`;

const prisma = new PrismaClient();
const createdUserIds = [];
const createdOrderIds = [];
const createdInventoryIds = [];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function loginViaAdmin(email) {
  const response = await fetch(`${ADMIN_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (response.status !== 200) {
    throw new Error(`管理后台登录失败 ${response.status}: ${await response.text()}`);
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/admin_session=([^;]+)/);
  if (!match) throw new Error(`未拿到 admin_session Cookie（set-cookie: ${setCookie.slice(0, 80)}）`);
  return match[1];
}

async function loginViaApi(email) {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const json = await response.json().catch(() => null);
  if (response.status !== 200 || !json?.data?.accessToken) {
    throw new Error(`后端登录失败 ${response.status}`);
  }
  return json.data.accessToken;
}

async function createUser(email, roleKey) {
  const user = await prisma.adminUser.create({
    data: {
      email,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
      name: `Verify ${roleKey}`,
      role: roleKey === 'SUPER_ADMIN' ? 'ADMIN' : 'EDITOR',
      isActive: true,
    },
  });
  createdUserIds.push(user.id);
  const role = await prisma.role.upsert({
    where: { key: roleKey },
    update: {},
    create: { key: roleKey, name: roleKey, isSystem: true },
  });
  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });
  return user;
}

const api = (token, method, path, body) =>
  fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function main() {
  try {
    // 1) 临时账号
    await createUser(ADMIN_EMAIL, 'SUPER_ADMIN');
    await createUser(SALES_EMAIL, 'SALES');
    await createUser(OTHER_EMAIL, 'SALES');
    check('创建临时账号（SUPER_ADMIN / SALES ×2）', true, PREFIX);

    const adminCookie = await loginViaAdmin(ADMIN_EMAIL);
    const salesCookie = await loginViaAdmin(SALES_EMAIL);
    check('管理后台登录并写入 HttpOnly Cookie', true, '两个账号均取得 admin_session');

    const adminToken = await loginViaApi(ADMIN_EMAIL);
    const salesToken = await loginViaApi(SALES_EMAIL);
    const otherToken = await loginViaApi(OTHER_EMAIL);
    check('后端直连登录（API Token）', true);

    // 2) 页面渲染（登录态 + 未登录）
    const ordersPage = await fetch(`${ADMIN_BASE}/orders`, {
      headers: { Cookie: `admin_session=${salesCookie}` },
    });
    const ordersHtml = await ordersPage.text();
    check(
      'GET /orders（业务员）渲染订单列表页（含订单编号筛选）',
      ordersPage.status === 200 && ordersHtml.includes('订单管理') && ordersHtml.includes('订单编号'),
      `HTTP ${ordersPage.status}`,
    );

    const inventoryPage = await fetch(`${ADMIN_BASE}/inventory`, {
      headers: { Cookie: `admin_session=${salesCookie}` },
    });
    const inventoryHtml = await inventoryPage.text();
    check(
      'GET /inventory（业务员）渲染库存列表页',
      inventoryPage.status === 200 &&
        inventoryHtml.includes('库存管理') &&
        inventoryHtml.includes('新增库存') &&
        inventoryHtml.includes('关联订单号'),
      `HTTP ${inventoryPage.status}`,
    );

    const anonOrders = await fetch(`${ADMIN_BASE}/orders`, { redirect: 'manual' });
    const anonInventory = await fetch(`${ADMIN_BASE}/inventory`, { redirect: 'manual' });
    check(
      '未登录访问 /orders、/inventory 均重定向到登录页',
      (anonOrders.status === 307 || anonOrders.status === 308) &&
        (anonInventory.status === 307 || anonInventory.status === 308),
      `orders=${anonOrders.status} inventory=${anonInventory.status}`,
    );

    const anonApi = await api(null, 'GET', '/cms/inventory');
    check('未登录访问后端 /cms/inventory 返回 401', anonApi.status === 401, `HTTP ${anonApi.status}`);

    // 3) 订单号规范化
    const orderCode = `VIN-${RUN_ID}-A1`;
    const createOrder = await api(salesToken, 'POST', '/cms/orders', {
      code: orderCode,
      customerName: `联调客户-${RUN_ID}`,
      country: 'China',
      requirement: '库存与订单号联调',
      orderedAt: '2026-10-01',
      amount: 8888.88,
      currency: 'CNY',
    });
    const orderJson = await createOrder.json().catch(() => null);
    const order = orderJson?.data;
    check(
      '新建订单：订单号手动填写且原样保存',
      createOrder.status === 201 && order?.code === orderCode,
      order ? `code=${order.code}` : JSON.stringify(orderJson).slice(0, 160),
    );
    if (!order) throw new Error('建单失败，后续步骤无法继续');
    createdOrderIds.push(order.id);

    const dup = await api(salesToken, 'POST', '/cms/orders', {
      code: orderCode,
      customerName: '重复订单号',
      country: 'China',
      requirement: '重复',
      orderedAt: '2026-10-01',
      amount: 1,
      currency: 'CNY',
    });
    const dupJson = await dup.json().catch(() => null);
    check(
      '重复订单号被拒（409 + 明确业务错误）',
      dup.status === 409 && JSON.stringify(dupJson).includes('该订单号已存在'),
      `HTTP ${dup.status}`,
    );

    const byCode = await api(adminToken, 'GET', `/cms/orders?code=${encodeURIComponent(orderCode)}`);
    const byCodeJson = await byCode.json();
    check(
      '按订单号精确查询（管理员）命中 1 条',
      byCode.status === 200 && byCodeJson?.data?.total === 1 && byCodeJson.data.items[0].id === order.id,
      `HTTP ${byCode.status} total=${byCodeJson?.data?.total}`,
    );

    const combined = await api(
      adminToken,
      'GET',
      `/cms/orders?code=${encodeURIComponent(orderCode)}&country=Mars`,
    );
    const combinedJson = await combined.json();
    check(
      '订单号查询与其它筛选叠加（国家不匹配 → 0 条）',
      combined.status === 200 && combinedJson?.data?.total === 0,
      `total=${combinedJson?.data?.total}`,
    );

    const otherSearch = await api(otherToken, 'GET', `/cms/orders?code=${encodeURIComponent(orderCode)}`);
    const otherSearchJson = await otherSearch.json();
    check(
      '业务员按他人订单号搜索：查不到（权限过滤）',
      otherSearch.status === 200 && otherSearchJson?.data?.total === 0,
      `total=${otherSearchJson?.data?.total}`,
    );

    const patchCode = await api(salesToken, 'PATCH', `/cms/orders/${order.id}`, {
      code: `${orderCode}-HACKED`,
      customerName: order.customerName,
      country: order.country,
      requirement: order.requirement,
      orderedAt: '2026-10-01',
      amount: 8888.88,
      currency: 'CNY',
    });
    check(
      '编辑订单不接受订单号字段（白名单拒绝，创建后不可改）',
      patchCode.status === 400,
      `HTTP ${patchCode.status}`,
    );

    // 4) 库存：从订单创建（自动关联）
    const linked = await api(salesToken, 'POST', '/cms/inventory', {
      productName: `联调库存-${RUN_ID}`,
      productDetail: '1220x2440x18mm 胡桃木贴面 MDF',
      quantity: 120.5,
      unit: '张',
      location: 'A区-3号货架-2层',
      storedAt: '2026-10-01',
      orderId: order.id,
    });
    const linkedJson = await linked.json().catch(() => null);
    const linkedItem = linkedJson?.data;
    check(
      '从订单创建库存：自动关联订单且订单号正确带入',
      linked.status === 201 &&
        linkedItem?.orderId === order.id &&
        linkedItem?.orderCode === orderCode &&
        linkedItem?.quantity === '120.5',
      linkedItem ? `code=${linkedItem.code} orderCode=${linkedItem.orderCode}` : JSON.stringify(linkedJson).slice(0, 160),
    );
    if (linkedItem) createdInventoryIds.push(linkedItem.id);

    // 未关联订单的库存
    const standalone = await api(salesToken, 'POST', '/cms/inventory', {
      productName: `独立库存-${RUN_ID}`,
      productDetail: '不关联订单',
      quantity: 8,
      unit: '立方米',
      location: 'C区-露天',
      storedAt: '2026-10-02',
    });
    const standaloneJson = await standalone.json().catch(() => null);
    check(
      '新增库存：支持不关联订单',
      standalone.status === 201 && standaloneJson?.data?.orderCode === null,
      `HTTP ${standalone.status}`,
    );
    if (standaloneJson?.data) createdInventoryIds.push(standaloneJson.data.id);

    // 列表：按关联订单号查询
    const byOrderCode = await api(salesToken, 'GET', `/cms/inventory?orderCode=${encodeURIComponent(orderCode)}`);
    const byOrderCodeJson = await byOrderCode.json();
    check(
      '库存列表按关联订单号查询命中',
      byOrderCode.status === 200 &&
        (byOrderCodeJson?.data?.items ?? []).some((i) => i.id === linkedItem?.id),
      `total=${byOrderCodeJson?.data?.total}`,
    );

    // 越权：other 看不到 salesA 的库存
    const otherList = await api(otherToken, 'GET', '/cms/inventory');
    const otherListJson = await otherList.json();
    check(
      '业务员只能看到自己的库存（越权列表为空）',
      otherList.status === 200 &&
        (otherListJson?.data?.items ?? []).every((i) => i.createdById !== undefined) &&
        (otherListJson?.data?.items ?? []).length === 0,
      `total=${otherListJson?.data?.total}`,
    );

    const otherDetail = await api(otherToken, 'GET', `/cms/inventory/${linkedItem.id}`);
    check('越权详情他人库存返回 404', otherDetail.status === 404, `HTTP ${otherDetail.status}`);

    const otherPatch = await api(otherToken, 'PATCH', `/cms/inventory/${linkedItem.id}`, {
      productName: '越权修改',
      productDetail: 'x',
      quantity: 1,
      unit: '张',
      location: 'x',
      storedAt: '2026-10-01',
      orderId: null,
    });
    check('越权编辑他人库存返回 403', otherPatch.status === 403, `HTTP ${otherPatch.status}`);

    const otherDelete = await api(otherToken, 'DELETE', `/cms/inventory/${linkedItem.id}`);
    check('越权删除他人库存返回 403', otherDelete.status === 403, `HTTP ${otherDelete.status}`);

    // 伪造关联：salesA 关联 salesB 的订单
    const otherOrder = await api(otherToken, 'POST', '/cms/orders', {
      code: `VIN-${RUN_ID}-B1`,
      customerName: '他人订单',
      country: 'China',
      requirement: '伪造关联测试',
      orderedAt: '2026-10-01',
      amount: 1,
      currency: 'CNY',
    });
    const otherOrderJson = await otherOrder.json().catch(() => null);
    if (otherOrderJson?.data) createdOrderIds.push(otherOrderJson.data.id);

    const fakeRelation = await api(salesToken, 'POST', '/cms/inventory', {
      productName: '伪造关联',
      productDetail: 'x',
      quantity: 1,
      unit: '张',
      location: 'x',
      storedAt: '2026-10-01',
      orderId: otherOrderJson?.data?.id ?? 'no-such-order',
    });
    check(
      '伪造关联他人订单被拒（403；订单不存在时 400）',
      [400, 403].includes(fakeRelation.status),
      `HTTP ${fakeRelation.status}`,
    );

    // 编辑字段白名单与负数量
    const whitelist = await api(salesToken, 'PATCH', `/cms/inventory/${linkedItem.id}`, {
      code: 'INV-HACKED',
      createdById: 'someone-else',
      productName: 'x',
      productDetail: 'x',
      quantity: 1,
      unit: '张',
      location: 'x',
      storedAt: '2026-10-01',
    });
    check('编辑库存提交 code / createdById 被白名单拒绝', whitelist.status === 400, `HTTP ${whitelist.status}`);

    const negative = await api(salesToken, 'POST', '/cms/inventory', {
      productName: '负数量',
      productDetail: 'x',
      quantity: -1,
      unit: '张',
      location: 'x',
      storedAt: '2026-10-01',
    });
    check('负数量库存被拒（400）', negative.status === 400, `HTTP ${negative.status}`);

    // 管理员可编辑他人库存
    const adminPatch = await api(adminToken, 'PATCH', `/cms/inventory/${linkedItem.id}`, {
      productName: `联调库存-${RUN_ID}`,
      productDetail: '1220x2440x18mm 胡桃木贴面 MDF',
      quantity: 99,
      unit: '张',
      location: 'A区-3号货架-2层',
      storedAt: '2026-10-01',
      orderId: order.id,
    });
    check('管理员可编辑全部库存', adminPatch.status === 200, `HTTP ${adminPatch.status}`);

    // 删除库存：不影响订单
    const del = await api(salesToken, 'DELETE', `/cms/inventory/${linkedItem.id}`);
    const delJson = await del.json().catch(() => null);
    check(
      '删除库存成功（200 + 编号回显）',
      del.status === 200 && delJson?.data?.code === linkedItem.code,
      `HTTP ${del.status}`,
    );

    const orderAfter = await api(salesToken, 'GET', `/cms/orders/${order.id}`);
    check(
      '删除库存后订单仍可读（不级联删除订单）',
      orderAfter.status === 200 && orderAfter.body !== undefined,
      `HTTP ${orderAfter.status}`,
    );

    // 5) 页面渲染：订单详情（关联库存卡）与订单锁定库存表单
    const orderDetailPage = await fetch(`${ADMIN_BASE}/orders/${order.id}`, {
      headers: { Cookie: `admin_session=${salesCookie}` },
    });
    const orderDetailHtml = await orderDetailPage.text();
    check(
      'GET /orders/[id] 渲染关联库存卡与「新增库存」入口',
      orderDetailPage.status === 200 &&
        orderDetailHtml.includes('关联库存') &&
        orderDetailHtml.includes('新增库存'),
      `HTTP ${orderDetailPage.status}`,
    );

    const newInventoryPage = await fetch(
      `${ADMIN_BASE}/inventory/new?orderId=${encodeURIComponent(order.id)}`,
      { headers: { Cookie: `admin_session=${salesCookie}` } },
    );
    const newInventoryHtml = await newInventoryPage.text();
    check(
      'GET /inventory/new?orderId= 渲染订单锁定表单（显示订单号）',
      newInventoryPage.status === 200 &&
        newInventoryHtml.includes('为订单新增库存') &&
        newInventoryHtml.includes(orderCode),
      `HTTP ${newInventoryPage.status}`,
    );

    const inventoryListAfter = await fetch(`${ADMIN_BASE}/inventory`, {
      headers: { Cookie: `admin_session=${salesCookie}` },
    });
    const inventoryListHtml = await inventoryListAfter.text();
    check(
      'GET /inventory（业务员）展示刚创建的独立库存',
      inventoryListAfter.status === 200 && inventoryListHtml.includes(`独立库存-${RUN_ID}`),
      `HTTP ${inventoryListAfter.status}`,
    );
  } finally {
    // 6) 清理（先库存后订单：库存外键 Restrict）
    for (const id of createdInventoryIds) {
      await prisma.inventoryItem.deleteMany({ where: { id } });
    }
    for (const id of createdOrderIds) {
      await prisma.orderAttachment.deleteMany({ where: { orderId: id } });
      await prisma.order.deleteMany({ where: { id } });
    }
    for (const id of createdUserIds) {
      await prisma.inventoryItem.deleteMany({ where: { createdById: id } });
      await prisma.orderAttachment.deleteMany({ where: { uploadedById: id } });
      await prisma.order.deleteMany({ where: { salespersonId: id } });
      await prisma.adminUserRole.deleteMany({ where: { adminUserId: id } });
      await prisma.adminUser.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
  }

  const failed = results.filter((one) => !one.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('联调脚本执行失败：', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
