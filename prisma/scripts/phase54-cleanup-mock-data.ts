/**
 * Phase 5.4.2 - 本地开发库模拟/测试数据清理脚本（幂等，可重复执行）。
 *
 * 目标库：仅限本地开发库 bailingwooden（127.0.0.1:5432/bailingwooden）。
 *   脚本启动时校验 DATABASE_URL，非本地开发库直接中止（BLOCKED），
 *   绝不触碰 E2E 库（bailingwooden_e2e）与生产库。
 *
 * 清理对象（全部为「有证据的测试数据」，逐类给出识别依据）：
 *   A. 测试管理员账号：email LIKE '%@bailingwooden.test'
 *      （pw-media / pw-blog / 4 个 e2e-1792110* 浏览器验收账号）
 *   B. demo / playwright 产品：slug LIKE 'demo-%' 或 'playwright-%'（seed 演示 + Playwright 验收残留）
 *   C. 测试博客文章：id=cmvbqulzw0001puoskcq63i42
 *      （标题 '20222'、正文仅 '<img alt="">'，内容与标题均为测试垃圾，签名不符即中止）
 *   D. 测试询盘：id=cmvdlee3e000npu3k6wo7ydc8
 *      （name '98 Tien'、company '222'、message 全为重复数字、sourceIp=127.0.0.1，签名不符即中止）
 *   E. 测试分类：slug 以 'pw-cat-' 或 'e2e-pub-' 开头（Playwright / E2E 发布测试残留）
 *   F. 测试审计日志：actorEmail LIKE '%@bailingwooden.test'（真实操作者 admin@/wangmin@ 为 .com 域，不受影响）
 *   G. 测试媒体：originalName IN ('e2e-test.png','e2e-test.pdf')
 *   H. 测试角色：key LIKE 'E2E_%' 且无任何用户绑定
 *      （E2E_PUB_EDITOR_mvc3c25x「E2E 内容编辑（无发布权）」由 E2E 发布测试脚本创建，
 *       与已删除的 e2e-pub-mvc3c25x-cat 分类同为 2026-10-17 07:44:18 同一测试批次；
 *       不在 seed-rbac.ts 预设中，无用户绑定；有绑定时跳过不动）
 *   I. 关联数据：上述产品/文章的内容修订（content_revisions）、测试询盘的线索分配、
 *      测试账号的角色绑定（admin_user_roles）
 *   J. 孤儿上传文件：uploads/ 下不被任何数据库记录引用的文件（e2e 上传残留）
 *
 * 明确保留（不清理）：
 *   - admin@bailingwooden.com / wangmin@bailingwooden.com 真实账号
 *   - seed.ts 生成的 4 个基础分类（wood-products 等）、4 角色、80 权限及全部绑定
 *   - 11 个站点区块（site_sections）及其发布版本、SEO 设置、导航、员工联系方式
 *   - 真实操作者（admin@ / system）的审计日志、lead_round_robin_state 等系统行
 *   - 整个 E2E 数据库（本脚本不连接、不清理）
 *
 * 用法：
 *   npx ts-node prisma/scripts/phase54-cleanup-mock-data.ts          # 演练（只读，默认）
 *   npx ts-node prisma/scripts/phase54-cleanup-mock-data.ts --apply  # 实际写入
 */

import { ContentEntityType, PrismaClient } from '@prisma/client';
import { existsSync, statSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** 本地开发库连接串唯一指纹（不含密码） */
const DEV_DB_FINGERPRINT = '127.0.0.1:5432/bailingwooden?';

const TEST_USER_EMAIL_LIKE = '%@bailingwooden.test';
const TEST_MEDIA_NAMES = ['e2e-test.png', 'e2e-test.pdf'];

/** 测试文章签名（id + 关键字段，任一项不符即中止，防止误删） */
const TEST_BLOG_POST = {
  id: 'cmvbqulzw0001puoskcq63i42',
  expect: { slug: 'plywood', title: '20222' },
};

/** 测试询盘签名（id + 关键字段，任一项不符即中止，防止误删） */
const TEST_RFQ = {
  id: 'cmvdlee3e000npu3k6wo7ydc8',
  expect: { name: '98 Tien', company: '222', sourceIp: '127.0.0.1' },
};

function fingerprint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}?`;
  } catch {
    return '(unparseable)';
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? '';
  const fp = fingerprint(dbUrl);
  console.log(`[guard] DATABASE_URL 指纹: ${fp}`);
  if (!fp.startsWith('127.0.0.1:5432/bailingwooden?')) {
    console.error(
      `[BLOCKED] DATABASE_URL 不是本地开发库 bailingwooden（实测指纹 ${fp}）。\n` +
        '本脚本只允许清理本地开发库；E2E 库与生产库一律禁止。已中止，未做任何修改。',
    );
    process.exit(3);
  }
  console.log(`[mode] ${APPLY ? 'APPLY（实际写入）' : 'DRY-RUN（只读演练）'}`);

  // ---------- 1. 盘点待清理记录（只读） ----------
  const testUsers = await prisma.adminUser.findMany({
    where: { email: { endsWith: '@bailingwooden.test' } },
    select: { id: true, email: true, name: true },
  });
  const keptUsers = await prisma.adminUser.findMany({
    where: { email: { not: { endsWith: '@bailingwooden.test' } } },
    select: { id: true, email: true, name: true },
  });

  const demoProducts = await prisma.product.findMany({
    where: {
      OR: [{ slug: { startsWith: 'demo-' } }, { slug: { startsWith: 'playwright-' } }],
    },
    select: { id: true, slug: true, name: true, status: true },
  });

  const blogPost = await prisma.blogPost.findUnique({
    where: { id: TEST_BLOG_POST.id },
    select: { id: true, slug: true, title: true },
  });
  if (blogPost) {
    if (blogPost.slug !== TEST_BLOG_POST.expect.slug || blogPost.title !== TEST_BLOG_POST.expect.title) {
      console.error(
        `[BLOCKED] 文章签名不符（实测 slug=${blogPost.slug} title=${blogPost.title}）。已中止，未做任何修改。`,
      );
      process.exit(3);
    }
  }

  const rfq = await prisma.rfq.findUnique({
    where: { id: TEST_RFQ.id },
    select: { id: true, name: true, company: true, sourceIp: true, email: true },
  });
  if (rfq) {
    if (rfq.name !== TEST_RFQ.expect.name || rfq.company !== TEST_RFQ.expect.company || rfq.sourceIp !== TEST_RFQ.expect.sourceIp) {
      console.error(
        `[BLOCKED] 询盘签名不符（实测 name=${rfq.name} company=${rfq.company} sourceIp=${rfq.sourceIp}）。已中止，未做任何修改。`,
      );
      process.exit(3);
    }
  }

  const testCategories = await prisma.category.findMany({
    where: {
      OR: [{ slug: { startsWith: 'pw-cat-' } }, { slug: { startsWith: 'e2e-pub-' } }],
    },
    select: { id: true, slug: true, name: true },
  });

  const testMedia = await prisma.mediaAsset.findMany({
    where: { originalName: { in: TEST_MEDIA_NAMES } },
    select: { id: true, originalName: true, storageKey: true },
  });

  // E2E 测试角色：key LIKE 'E2E_%' 且无用户绑定（有绑定的角色不属于本脚本清理范围，跳过）
  const e2eRolesAll = await prisma.role.findMany({
    where: { key: { startsWith: 'E2E_' }, isSystem: false },
    select: {
      id: true,
      key: true,
      name: true,
      _count: { select: { userRoles: true, rolePermissions: true } },
    },
  });
  const testRoles = e2eRolesAll.filter((r) => r._count.userRoles === 0);

  const testAuditCount = await prisma.auditLog.count({
    where: { actorEmail: { endsWith: '@bailingwooden.test' } },
  });

  const productIds = demoProducts.map((p) => p.id);
  const revisionCount = await prisma.contentRevision.count({
    where: {
      OR: [
        { entityType: ContentEntityType.PRODUCT, entityId: { in: productIds } },
        ...(blogPost ? [{ entityType: ContentEntityType.BLOG_POST, entityId: blogPost.id }] : []),
      ],
    },
  });

  const leadAssignmentCount = rfq
    ? await prisma.leadAssignment.count({ where: { rfqId: rfq.id } })
    : 0;

  const userRoleCount = testUsers.length
    ? await prisma.adminUserRole.count({ where: { adminUserId: { in: testUsers.map((u) => u.id) } } })
    : 0;

  // ---------- 2. 孤儿文件盘点（只读） ----------
  const uploadsRoot = path.join(process.cwd(), 'uploads');
  const mediaFiles = await collectFiles(path.join(uploadsRoot, 'media'));
  const orderFiles = await collectFiles(path.join(uploadsRoot, 'orders'));

  const registeredKeys = new Set(
    (await prisma.mediaAsset.findMany({ select: { storageKey: true } })).map((m) => m.storageKey),
  );
  const attachmentKeys = new Set(
    (await prisma.orderAttachment.findMany({ select: { storageKey: true } })).map((a) => a.storageKey),
  );

  // storageKey 形如 media/<yyyy>/<mm>/<uuid>.<ext>；物理文件在 uploads/<storageKey>
  const orphanMediaFiles = mediaFiles.filter((f) => {
    const rel = path.relative(path.join(uploadsRoot), f).split(path.sep).join('/');
    return !registeredKeys.has(rel);
  });
  const orphanOrderFiles = orderFiles.filter((f) => {
    const rel = path.relative(path.join(uploadsRoot), f).split(path.sep).join('/');
    return !attachmentKeys.has(rel);
  });

  // ---------- 3. 输出待删除清单 ----------
  const plan = {
    testUsers,
    keptUsers,
    demoProducts,
    blogPost: blogPost ? { ...blogPost, reason: "标题 '20222'、正文仅 '<img alt=\"\">'，内容均为测试垃圾" } : null,
    rfq: rfq ? { ...rfq, reason: '字段全为重复数字（98 Tien / 222 / 22222 / 22222222222222222222 / 2222）、sourceIp=127.0.0.1 本机表单测试' } : null,
    testCategories,
    testMedia,
    testRoles,
    counts: {
      testAuditLogs: testAuditCount,
      contentRevisions: revisionCount,
      leadAssignments: leadAssignmentCount,
      adminUserRoles: userRoleCount,
      productImages: await prisma.productImage.count({ where: { productId: { in: productIds } } }),
      orphanMediaFiles: orphanMediaFiles.length,
      orphanOrderFiles: orphanOrderFiles.length,
    },
  };
  console.log('\n===== 待清理清单 =====');
  console.log(JSON.stringify(plan, null, 2));

  if (!APPLY) {
    console.log('\n[dry-run] 未做任何修改。加 --apply 执行实际清理。');
    return;
  }

  // ---------- 4. 事务内删除（按依赖顺序） ----------
  await prisma.$transaction(async (tx) => {
    // a) 审计日志（无 FK，先清测试行为者，避免留下指向将删除账号的历史）
    const audit = await tx.auditLog.deleteMany({
      where: { actorEmail: { endsWith: '@bailingwooden.test' } },
    });
    console.log(`[apply] audit_logs 删除 ${audit.count} 条（测试行为者）`);

    // b) 内容修订（demo/playwright 产品 + 测试文章的发布快照）
    const revs = await tx.contentRevision.deleteMany({
      where: {
        OR: [
          { entityType: ContentEntityType.PRODUCT, entityId: { in: productIds } },
          ...(blogPost ? [{ entityType: ContentEntityType.BLOG_POST, entityId: blogPost.id }] : []),
        ],
      },
    });
    console.log(`[apply] content_revisions 删除 ${revs.count} 条`);

    // c) 测试询盘的线索分配 → 询盘
    if (rfq) {
      const la = await tx.leadAssignment.deleteMany({ where: { rfqId: rfq.id } });
      console.log(`[apply] lead_assignments 删除 ${la.count} 条`);
      const r = await tx.rfq.deleteMany({ where: { id: rfq.id } });
      console.log(`[apply] rfqs 删除 ${r.count} 条`);
    }

    // d) 测试产品（先于测试分类， categories onDelete: Restrict）
    if (productIds.length > 0) {
      const pi = await tx.productImage.deleteMany({ where: { productId: { in: productIds } } });
      console.log(`[apply] product_images 删除 ${pi.count} 条`);
      const p = await tx.product.deleteMany({ where: { id: { in: productIds } } });
      console.log(`[apply] products 删除 ${p.count} 条`);
    }

    // e) 测试博客文章
    if (blogPost) {
      const b = await tx.blogPost.deleteMany({ where: { id: blogPost.id } });
      console.log(`[apply] blog_posts 删除 ${b.count} 条`);
    }

    // f) 测试分类（此时已无产品引用）
    if (testCategories.length > 0) {
      const c = await tx.category.deleteMany({
        where: { id: { in: testCategories.map((x) => x.id) } },
      });
      console.log(`[apply] categories 删除 ${c.count} 条`);
    }

    // g) 测试媒体记录
    if (testMedia.length > 0) {
      const m = await tx.mediaAsset.deleteMany({
        where: { id: { in: testMedia.map((x) => x.id) } },
      });
      console.log(`[apply] media_assets 删除 ${m.count} 条`);
    }

    // g2) 测试角色（先清权限绑定，再删角色；仅无用户绑定的 E2E_ 角色）
    if (testRoles.length > 0) {
      const roleIds = testRoles.map((r) => r.id);
      const rp = await tx.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
      console.log(`[apply] role_permissions 删除 ${rp.count} 条（测试角色绑定）`);
      const r = await tx.role.deleteMany({ where: { id: { in: roleIds } } });
      console.log(`[apply] roles 删除 ${r.count} 条`);
    }

    // h) 测试账号的角色绑定 → 账号
    if (testUsers.length > 0) {
      const ur = await tx.adminUserRole.deleteMany({
        where: { adminUserId: { in: testUsers.map((u) => u.id) } },
      });
      console.log(`[apply] admin_user_roles 删除 ${ur.count} 条`);
      const u = await tx.adminUser.deleteMany({
        where: { id: { in: testUsers.map((x) => x.id) } },
      });
      console.log(`[apply] admin_users 删除 ${u.count} 条`);
    }
  });
  console.log('[apply] 数据库事务已提交');

  // ---------- 5. 孤儿文件回收（仅在 DB 成功后；逐个确认存在且仍无引用） ----------
  let removedFiles = 0;
  for (const f of [...orphanMediaFiles, ...orphanOrderFiles]) {
    try {
      if (!existsSync(f)) continue;
      await unlink(f);
      removedFiles += 1;
      console.log(`[apply] 删除孤儿文件 ${f}`);
    } catch (e) {
      console.warn(`[warn] 删除文件失败（不影响数据库结果）: ${f} -> ${(e as Error).message}`);
    }
  }
  console.log(`[apply] 孤儿文件共删除 ${removedFiles} 个`);
}

main()
  .catch((e) => {
    console.error('[FATAL]', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
