/**
 * 销售（SALES）角色权限收敛脚本（幂等，可重复执行）。
 *
 * 背景：
 *   2026-10-19 起业务定位调整——销售只开放「工作台 + 样品 / 订单 / 库存
 *   （自己的数据）+ 员工联系方式只读」，不再涉及询盘（rfq / lead_distribution）
 *   与内容模块（products / media）。
 *
 *   seed-rbac.ts 的内置角色绑定是**增量语义**（只补不删），因此光改常量
 *   不会回收已发放的多余权限；本脚本负责把数据库收敛为常量定义的精确集：
 *     1. seedPermissions / seedBuiltinRoles：同步权限清单、角色名称与描述，补齐缺失预设
 *     2. 删除 SALES 角色下**不在** SALES_PERMISSIONS 的 role_permissions 绑定
 *
 * 用法：
 *   npx ts-node prisma/scripts/restrict-sales-permissions.ts          # 演练（只读，默认）
 *   npx ts-node prisma/scripts/restrict-sales-permissions.ts --apply  # 实际写入
 *
 * 红线：只动 role_permissions 绑定，绝不删除 permission 定义行、不动其他角色。
 */

import { PrismaClient } from '@prisma/client';
import {
  SALES_PERMISSIONS,
  seedBuiltinRoles,
  seedPermissions,
} from '../seed-rbac';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const ROLE_KEY = 'SALES';

async function main(): Promise<void> {
  // 1) 同步权限清单与内置角色（幂等 upsert；含角色名称/描述、预设权限补齐）
  const idByKey = await seedPermissions(prisma);
  await seedBuiltinRoles(prisma, idByKey);

  // 2) 校验目标权限集全部已注册
  const missing = SALES_PERMISSIONS.filter((k) => !idByKey.has(k));
  if (missing.length > 0) {
    throw new Error(`SALES 目标权限集引用了未注册的权限: ${missing.join(', ')}`);
  }

  const role = await prisma.role.findUnique({
    where: { key: ROLE_KEY },
    select: { id: true, key: true, name: true },
  });
  if (!role) throw new Error(`角色 ${ROLE_KEY} 不存在，请先执行 prisma:seed`);

  const [bound, users] = await Promise.all([
    prisma.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permissionId: true },
    }),
    prisma.adminUserRole.count({ where: { roleId: role.id } }),
  ]);

  const allPermissions = await prisma.permission.findMany({ select: { id: true, key: true } });
  const keyById = new Map(allPermissions.map((p) => [p.id, p.key]));

  const targetIds = new Set(SALES_PERMISSIONS.map((k) => idByKey.get(k)!));
  const toRemove = bound
    .map((b) => b.permissionId)
    .filter((id) => !targetIds.has(id));
  const boundIds = new Set(bound.map((b) => b.permissionId));
  const toAdd = [...targetIds].filter((id) => !boundIds.has(id));

  const fmt = (ids: string[]) =>
    ids.map((id) => keyById.get(id) ?? id).sort().join(', ') || '（无）';

  console.log(`[sales-restrict] 角色: ${role.key}（${role.name}），关联账号 ${users} 个`);
  console.log(`[sales-restrict] 当前绑定 ${bound.length} 项，目标集 ${SALES_PERMISSIONS.length} 项`);
  console.log(`[sales-restrict] 待移除: ${fmt(toRemove)}`);
  console.log(`[sales-restrict] 待补齐: ${fmt(toAdd)}`);

  if (!APPLY) {
    console.log('[sales-restrict] 演练模式（未写入）。加 --apply 实际执行。');
    return;
  }

  if (toRemove.length > 0) {
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { in: toRemove } },
    });
    console.log(`[sales-restrict] 已移除 ${toRemove.length} 项越界权限`);
  }
  if (toAdd.length > 0) {
    await prisma.rolePermission.createMany({
      data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
    console.log(`[sales-restrict] 已补齐 ${toAdd.length} 项缺失权限`);
  }

  // 3) 复核：最终集必须与目标逐字一致
  const finalBound = await prisma.rolePermission.findMany({
    where: { roleId: role.id },
    select: { permissionId: true },
  });
  const finalKeys = new Set(
    finalBound.map((b) => keyById.get(b.permissionId) ?? b.permissionId),
  );
  const expected = new Set(SALES_PERMISSIONS);
  const diff = [...finalKeys].filter((k) => !expected.has(k));
  const lack = [...expected].filter((k) => !finalKeys.has(k));
  if (diff.length > 0 || lack.length > 0) {
    throw new Error(
      `[sales-restrict] 复核失败：多余 ${diff.join(', ') || '无'}；缺失 ${lack.join(', ') || '无'}`,
    );
  }
  console.log(`[sales-restrict] 复核通过：SALES 权限集 = ${[...expected].sort().join(', ')}`);
}

main()
  .catch((error) => {
    console.error('[sales-restrict] 执行失败:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
