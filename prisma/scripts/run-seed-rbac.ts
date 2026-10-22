import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  migrateLegacyRoles,
  seedBuiltinRoles,
  seedPermissions,
} from '../seed-rbac';

/**
 * RBAC 单跑入口（幂等）。
 *
 * 背景：seed-rbac.ts 只导出函数、无执行入口；完整数据种子走 prisma/seed.ts。
 * 本 runner 仅同步「权限清单 + 内置角色 + 历史账号角色迁移」，
 * 用于新增权限后在生产 / e2e 库快速落地，不触碰业务数据。
 *
 * 运行：npx ts-node prisma/scripts/run-seed-rbac.ts
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const permissionIdByKey = await seedPermissions(prisma);
    const roleIdByKey = await seedBuiltinRoles(prisma, permissionIdByKey);
    await migrateLegacyRoles(prisma, roleIdByKey);
    console.log('[seed:rbac] 完成');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[seed:rbac] 失败', error);
  process.exit(1);
});
