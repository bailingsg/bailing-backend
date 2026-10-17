/**
 * Phase 5.2 管理端真实联调验证（一次性脚本）。
 *
 * 目的：验证 Next.js 管理后台与后端代理链路，而非只测后端 API：
 *   1. 临时创建 SUPER_ADMIN / SALES 两个账号（bcrypt 低成本哈希，与 e2e 同手法）；
 *   2. 经管理后台 /api/auth/login 登录拿到 HttpOnly Cookie；
 *   3. 业务员经 /api/order-photos/upload 代理上传 PNG（临时态）；
 *   4. 经后端 API 创建订单并关联该附件；
 *   5. 经代理读取图片：本人 200（PNG 魔数）；越权账号非 200；无 Cookie 401；
 *   6. 订单列表页 / 详情页渲染（HTML 含关键字段）；
 *   7. 媒体库隔离复核（/cms/media 搜不到订单附件）；
 *   8. 清理：订单、附件行、上传文件、临时账号（finally 保证执行）。
 *
 * 运行：node scripts/verify-orders-admin-flow.mjs
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

const ADMIN_BASE = process.env.ADMIN_BASE ?? 'http://127.0.0.1:3001';
const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000/api/v1';
const PASSWORD = 'Verify-pass-2026!';
const RUN_ID = Date.now().toString(36);
const PREFIX = 'verify-orders';

const ADMIN_EMAIL = `${PREFIX}-admin-${RUN_ID}@bailingwooden.test`;
const SALES_EMAIL = `${PREFIX}-sales-${RUN_ID}@bailingwooden.test`;
const OTHER_EMAIL = `${PREFIX}-other-${RUN_ID}@bailingwooden.test`;

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(`verify-order-photo-${RUN_ID}`),
]);

const prisma = new PrismaClient();
const createdUserIds = [];
const createdOrderIds = [];
const createdAttachmentIds = [];
const createdFiles = [];

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

async function main() {
  try {
    // 1) 临时账号
  const adminUser = await createUser(ADMIN_EMAIL, 'SUPER_ADMIN');
  const salesUser = await createUser(SALES_EMAIL, 'SALES');
  const otherUser = await createUser(OTHER_EMAIL, 'SALES');
  check('创建临时账号（SUPER_ADMIN / SALES ×2）', true, `${ADMIN_EMAIL} 等`);

  const adminCookie = await loginViaAdmin(ADMIN_EMAIL);
  const salesCookie = await loginViaAdmin(SALES_EMAIL);
  const otherCookie = await loginViaAdmin(OTHER_EMAIL);
  check('管理后台登录并写入 HttpOnly Cookie', true, '三个账号均取得 admin_session');

  const salesToken = await loginViaApi(SALES_EMAIL);
  check('后端直连登录（用于建单）', true);

  // 2) 页面渲染
  const listPage = await fetch(`${ADMIN_BASE}/orders`, {
    headers: { Cookie: `admin_session=${salesCookie}` },
  });
  const listHtml = await listPage.text();
  check(
    'GET /orders（业务员）渲染订单列表页',
    listPage.status === 200 && listHtml.includes('订单管理') && listHtml.includes('新增订单'),
    `HTTP ${listPage.status}`,
  );

  const samplesPage = await fetch(`${ADMIN_BASE}/samples`, {
    headers: { Cookie: `admin_session=${salesCookie}` },
  });
  const samplesHtml = await samplesPage.text();
  check(
    'GET /samples（业务员）渲染样品列表页',
    samplesPage.status === 200 && samplesHtml.includes('样品管理'),
    `HTTP ${samplesPage.status}`,
  );

  const anonList = await fetch(`${ADMIN_BASE}/orders`, { redirect: 'manual' });
  check(
    'GET /orders（未登录）被重定向到登录',
    anonList.status === 307 || anonList.status === 308,
    `HTTP ${anonList.status} → ${anonList.headers.get('location') ?? '无 Location'}`,
  );

  // 3) 经代理上传 PNG（业务员）
  const form = new FormData();
  form.append('file', new File([PNG_BYTES], `verify-photo-${RUN_ID}.png`, { type: 'image/png' }));
  const upload = await fetch(`${ADMIN_BASE}/api/order-photos/upload`, {
    method: 'POST',
    headers: { Cookie: `admin_session=${salesCookie}` },
    body: form,
  });
  const uploadJson = await upload.json().catch(() => null);
  const attachment = uploadJson?.data;
  check(
    'POST /api/order-photos/upload 上传成功（201 + 附件 ID）',
    upload.status === 201 && attachment?.id,
    attachment ? `attachmentId=${attachment.id.slice(0, 8)}…` : JSON.stringify(uploadJson).slice(0, 160),
  );
  if (!attachment) throw new Error('上传失败，后续步骤无法继续');
  createdAttachmentIds.push(attachment.id);

  // 上传接口鉴权：无 Cookie 必须 401
  const anonUpload = await fetch(`${ADMIN_BASE}/api/order-photos/upload`, {
    method: 'POST',
    body: form,
  });
  check('POST /api/order-photos/upload（无 Cookie）401', anonUpload.status === 401, `HTTP ${anonUpload.status}`);

  // 4) 创建订单并关联附件
  const createOrder = await fetch(`${API_BASE}/cms/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      customerName: 'Verify Customer Co.',
      country: 'United States',
      requirement: '验证用订单：18mm 胡桃木直纹面板 200 片。',
      orderedAt: new Date().toISOString(),
      amount: 1234.5,
      currency: 'USD',
      note: 'Phase 5.2 联调验证',
      attachmentIds: [attachment.id],
    }),
  });
  const orderJson = await createOrder.json().catch(() => null);
  const order = orderJson?.data;
  check(
    'POST /cms/orders 创建订单并关联附件',
    createOrder.status === 201 && order?.id && order.attachments?.length === 1,
    order ? `code=${order.code}` : JSON.stringify(orderJson).slice(0, 200),
  );
  if (!order) throw new Error('建单失败，后续步骤无法继续');
  createdOrderIds.push(order.id);

  // 5) 代理读图鉴权
  const photoUrl = `${ADMIN_BASE}/api/order-photos/${order.id}/${attachment.id}`;
  const ownPhoto = await fetch(photoUrl, { headers: { Cookie: `admin_session=${salesCookie}` } });
  const ownBytes = Buffer.from(await ownPhoto.arrayBuffer());
  check(
    'GET 代理图片（本人 Cookie）200 且为 PNG 魔数',
    ownPhoto.status === 200 &&
      ownBytes.length >= 8 &&
      ownBytes[0] === 0x89 &&
      ownBytes[1] === 0x50 &&
      ownBytes[2] === 0x4e &&
      ownBytes[3] === 0x47,
    `HTTP ${ownPhoto.status}, ${ownBytes.length} bytes`,
  );

  const otherPhoto = await fetch(photoUrl, { headers: { Cookie: `admin_session=${otherCookie}` } });
  check(
    'GET 代理图片（其他业务员）被拒（403/404）',
    otherPhoto.status === 403 || otherPhoto.status === 404,
    `HTTP ${otherPhoto.status}`,
  );

  const anonPhoto = await fetch(photoUrl);
  check('GET 代理图片（无 Cookie）401', anonPhoto.status === 401, `HTTP ${anonPhoto.status}`);

  const adminPhoto = await fetch(photoUrl, { headers: { Cookie: `admin_session=${adminCookie}` } });
  check('GET 代理图片（管理员）200（管理员可查看全部）', adminPhoto.status === 200, `HTTP ${adminPhoto.status}`);

  // 6) 详情页渲染
  const detailPage = await fetch(`${ADMIN_BASE}/orders/${order.id}`, {
    headers: { Cookie: `admin_session=${salesCookie}` },
  });
  const detailHtml = await detailPage.text();
  check(
    'GET /orders/[id] 详情页渲染（含客户名与金额）',
    detailPage.status === 200 &&
      detailHtml.includes('Verify Customer Co.') &&
      detailHtml.includes('订单照片') &&
      detailHtml.includes(orderPhotoUrlHref(order.id, attachment.id)),
    `HTTP ${detailPage.status}`,
  );

  // 越权详情页 → 404
  const otherDetail = await fetch(`${ADMIN_BASE}/orders/${order.id}`, {
    headers: { Cookie: `admin_session=${otherCookie}` },
  });
  check('GET /orders/[id]（其他业务员）404', otherDetail.status === 404, `HTTP ${otherDetail.status}`);

  // 7) 媒体库隔离复核
  const media = await fetch(
    `${API_BASE}/cms/media?keyword=verify-order-photo-${RUN_ID}&limit=20`,
    { headers: { Authorization: `Bearer ${salesToken}` } },
  );
  const mediaJson = await media.json().catch(() => null);
  const mediaItems = mediaJson?.data?.items ?? [];
  const leaked = mediaItems.filter((item) => JSON.stringify(item).includes(`verify-order-photo-${RUN_ID}`));
  check(
    '媒体库搜索搜不到订单附件（/cms/media 隔离）',
    media.status === 200 && leaked.length === 0,
    `命中 ${mediaItems.length} 条`,
  );

  const detailMedia = await fetch(`${API_BASE}/cms/media/${attachment.id}`, {
    headers: { Authorization: `Bearer ${salesToken}` },
  });
  check(
    '媒体库详情接口不暴露订单附件（403/404）',
    detailMedia.status === 403 || detailMedia.status === 404,
    `HTTP ${detailMedia.status}`,
  );

  // 8) 越权编辑复核（服务层 403）
  const hackUpdate = await fetch(`${API_BASE}/cms/orders/${order.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await loginViaApi(OTHER_EMAIL)}` },
    body: JSON.stringify({
      customerName: 'Hacked',
      country: 'Nowhere',
      requirement: 'x',
      orderedAt: new Date().toISOString(),
      amount: 1,
      currency: 'CNY',
    }),
  });
  check('PATCH /cms/orders/:id（其他业务员）403', hackUpdate.status === 403, `HTTP ${hackUpdate.status}`);

  void adminUser;
} finally {
  // 清理（顺序：附件文件 → 附件行 → 订单行 → 账号）
  for (const attachmentId of createdAttachmentIds) {
    const row = await prisma.orderAttachment
      .findUnique({ where: { id: attachmentId }, select: { storageKey: true } })
      .catch(() => null);
    if (row?.storageKey) {
      const filePath = path.resolve(process.cwd(), 'uploads', row.storageKey);
      if (filePath.startsWith(path.resolve(process.cwd(), 'uploads', 'orders')) && fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
        createdFiles.push(filePath);
      }
    }
  }
  await prisma.orderAttachment.deleteMany({ where: { id: { in: createdAttachmentIds } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
  for (const userId of createdUserIds) {
    await prisma.orderAttachment.deleteMany({ where: { uploadedById: userId } }).catch(() => {});
    await prisma.order.deleteMany({ where: { salespersonId: userId } }).catch(() => {});
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: userId } }).catch(() => {});
    await prisma.adminUser.deleteMany({ where: { id: userId } }).catch(() => {});
  }
  console.log(`\n清理完成：账号 ${createdUserIds.length}、订单 ${createdOrderIds.length}、附件 ${createdAttachmentIds.length}、文件 ${createdFiles.length}`);
  await prisma.$disconnect();

  const failed = results.filter((one) => !one.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) process.exitCode = 1;
  }
}

function orderPhotoUrlHref(orderId, attachmentId) {
  return `/api/order-photos/${orderId}/${attachmentId}`;
}

main().catch(async (error) => {
  console.error('脚本执行失败：', error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
