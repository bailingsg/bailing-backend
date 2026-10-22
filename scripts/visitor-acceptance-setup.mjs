/**
 * 访客统计浏览器验收 — 测试账号与夹具准备（本地开发库，Prisma 版）。
 *
 * 创建两个账号：
 *   · visitor-super@bailingwooden.test  → SUPER_ADMIN（全部权限）
 *   · visitor-viewer@bailingwooden.test → 自定义角色，仅 visitor_stats.read
 * 并写入少量访客会话夹具（今日 3 位访客 5 次、昨日 2 位访客 2 次）。
 *
 * 用法（backend 目录下）：
 *   DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" node scripts/visitor-acceptance-setup.mjs
 * 幂等：重复执行先清理旧账号再重建。
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const SUPER = 'visitor-super@bailingwooden.test';
const VIEWER = 'visitor-viewer@bailingwooden.test';
const PASS = 'E2E-pass-2026!';

// ---- 清理旧数据 ----
for (const email of [SUPER, VIEWER]) {
  const old = await prisma.adminUser.findUnique({ where: { email }, select: { id: true } });
  if (old) {
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: old.id } });
    await prisma.adminUser.delete({ where: { id: old.id } });
  }
}
await prisma.role.deleteMany({ where: { key: 'e2e_visitor_browser', isSystem: false } });
await prisma.visitorSession.deleteMany({ where: { visitorId: { startsWith: 'acc00000-' } } });
await prisma.visitorDailyStatistic.deleteMany({});

// ---- SUPER_ADMIN 账号 ----
const superRole = await prisma.role.findUnique({ where: { key: 'SUPER_ADMIN' } });
if (!superRole) throw new Error('SUPER_ADMIN 角色缺失，请先跑 seed-rbac');
await prisma.adminUser.create({
  data: {
    email: SUPER,
    passwordHash: bcrypt.hashSync(PASS, 4),
    name: '访客验收超管',
    role: 'ADMIN',
    isActive: true,
    userRoles: { create: { roleId: superRole.id } },
  },
});

// ---- viewer：自定义角色含 dashboard.read + visitor_stats.read（无 visitor_records.read）----
const permKeys = ['dashboard.read', 'visitor_stats.read'];
const perms = [];
for (const key of permKeys) {
  const perm = await prisma.permission.findUnique({ where: { key } });
  if (!perm) throw new Error(`permission ${key} 缺失，请先跑 seed-rbac`);
  perms.push(perm);
}
const viewerRole = await prisma.role.create({
  data: {
    key: 'e2e_visitor_browser',
    name: 'e2e_visitor_browser',
    isSystem: false,
    status: 'ACTIVE',
    rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) },
  },
});
await prisma.adminUser.create({
  data: {
    email: VIEWER,
    passwordHash: bcrypt.hashSync(PASS, 4),
    name: '访客验收受限',
    role: 'EDITOR',
    isActive: true,
    userRoles: { create: { roleId: viewerRole.id } },
  },
});

// ---- 访客夹具 ----
const now = Date.now();
const utcDayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
const fixtures = [
  ['acc00000-0001', now - 10 * 60_000, 2, 'CN', '杭州', '203.0.113.0/24'],
  ['acc00000-0002', now - 30 * 60_000, 1, 'US', 'New York', '198.51.100.0/24'],
  ['acc00000-0003', now - 60 * 60_000, 2, 'DE', 'Berlin', '192.0.2.0/24'],
  ['acc00000-0001', utcDayStart - 86_400_000 + 3_600_000, 1, 'CN', '杭州', '203.0.113.0/24'],
  ['acc00000-0004', utcDayStart - 86_400_000 + 7_200_000, 1, 'JP', 'Tokyo', '203.0.114.0/24'],
];
for (const [vid, first, pv, country, city, mip] of fixtures) {
  await prisma.visitorSession.create({
    data: {
      visitorId: vid,
      firstSeenAt: new Date(first),
      lastSeenAt: new Date(first + 15 * 60_000),
      visitCount: pv,
      country,
      city,
      maskedIp: mip,
      isNewVisitor: false,
    },
  });
}

console.log('OK: 测试账号与访客夹具就绪');
console.log(`  超管: ${SUPER} / ${PASS}`);
console.log(`  受限: ${VIEWER} / ${PASS}`);
await prisma.$disconnect();
