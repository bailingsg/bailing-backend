import { PrismaClient, RoleStatus } from '@prisma/client';
import {
  PERMISSIONS,
  PROTECTED_ROLE_KEYS,
  SUPER_ADMIN_ROLE_KEY,
  type PermissionAction,
  type PermissionDefinition,
} from '../src/modules/rbac/permission.registry';

/**
 * RBAC 种子（Phase 4.6）。
 *
 * 三件事：
 *   1. **同步权限清单**：把 permission.registry.ts 的固定清单 upsert 进 permissions 表
 *      （新增权限补进去、名称/描述/排序按代码为准更新；代码里删掉的权限会清理关联）
 *   2. **创建内置系统角色**：SUPER_ADMIN（受保护）+ CONTENT_EDITOR（内容编辑，最小权限）
 *   3. **迁移历史角色**：按 admin_users.role 旧枚举建立 admin_user_roles 关联
 *      · ADMIN  → SUPER_ADMIN
 *      · EDITOR → CONTENT_EDITOR
 *      **绝不**把全部 EDITOR 提升为超级管理员；EDITOR 只拿到内容类权限
 *
 * 幂等：可重复执行。
 */

/**
 * 内容编辑角色默认权限（仅内容类；不含账号/角色/分发等管理权限）。
 *
 * Phase 1 起**不预置任何 `*.publish` / `*.unpublish`**：
 *   · 保存编辑稿只需 `*.update`；让内容对外可见必须另有 `*.publish`。
 *   · 取消发布（下架）是比发布更敏感的动作，`*.unpublish` 单独授予。
 *   · 若客户希望内容编辑保留「改完即可上线」的旧能力，请在
 *     「角色与权限」页为其显式勾选对应 `*.publish`，不要改本文件默认值
 *     —— 默认值代表最小权限基线，是审计依据。
 */
const CONTENT_EDITOR_PERMISSIONS: readonly string[] = [
  'dashboard.read',
  'products.read',
  'products.create',
  'products.update',
  'categories.read',
  'media.read',
  'media.upload',
  'media.update',
  'blog.read',
  'blog.create',
  'blog.update',
  'factory.read',
  'factory.create',
  'factory.update',
  'quality.read',
  'quality.create',
  'quality.update',
  'applications.read',
  'applications.create',
  'applications.update',
  // Phase 4.7：站点结构化内容（首页 / 关于我们 / 联系页文案维护）。
  // 与 factory/quality/applications 同边界：不含 delete；导航管理（nav.*）不授予。
  'site.read',
  'site.create',
  'site.update',
  // Phase 5.0：内容编辑者维护所辖内容的 SEO 元数据（不含全局设置 / 重定向 / 审计触发）
  'seo.read',
  'seo.manage',
];

/** 销售（询盘跟进）角色默认权限：看询盘 + 跟进状态 + 分配情况 + 联系方式只读 */
export const SALES_PERMISSIONS: readonly string[] = [
  'dashboard.read',
  'rfq.read',
  'rfq.update',
  'contacts.read',
  'lead_distribution.read',
  'products.read',
  'media.read',
  // Phase 5.1：样品管理（持有 / 被授权查看 / 出库申请；审批由持有人身份判定）
  'samples.read',
  'samples.create',
  'samples.update',
  // Phase 5.2：订单管理（自己的订单）
  'orders.read',
  'orders.create',
  'orders.update',
];

/** 内置角色定义 */
interface BuiltinRole {
  key: string;
  name: string;
  description: string;
  sortOrder: number;
  /** 是否受保护（不可停用/改权限/删除） */
  isSystem: boolean;
  /** 预设权限 key（SUPER_ADMIN 不写，由代码恒等于全集） */
  permissions: readonly string[];
}

const BUILTIN_ROLES: readonly BuiltinRole[] = [
  {
    key: SUPER_ADMIN_ROLE_KEY,
    name: '超级管理员',
    description: '拥有系统全部权限，不可停用、不可修改权限、不可删除。',
    sortOrder: 0,
    isSystem: true,
    permissions: [],
  },
  {
    key: 'CONTENT_EDITOR',
    name: '内容编辑',
    description: '负责产品、分类、媒体、文章、工厂、质量、应用场景的日常维护，不含账号与角色管理。',
    sortOrder: 10,
    isSystem: false,
    permissions: CONTENT_EDITOR_PERMISSIONS,
  },
  {
    key: 'SALES',
    name: '销售',
    description: '查看询盘分配情况与员工对外联系方式，不参与内容与账号管理。',
    sortOrder: 20,
    isSystem: false,
    permissions: SALES_PERMISSIONS,
  },
];

function assertPermissionKeys(roleKey: string, keys: readonly string[]): void {
  const known = new Set(PERMISSIONS.map((p) => p.key));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(`内置角色 ${roleKey} 引用了未注册的权限: ${unknown.join(', ')}`);
  }
}

/** 1. 同步权限清单 */
export async function seedPermissions(prisma: PrismaClient): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>();

  for (const def of PERMISSIONS as readonly PermissionDefinition[]) {
    const record = await prisma.permission.upsert({
      where: { key: def.key },
      update: {
        module: def.module,
        action: def.action as PermissionAction,
        name: def.name,
        description: def.description,
        isNav: def.isNav,
        sortOrder: def.sortOrder,
      },
      create: {
        key: def.key,
        module: def.module,
        action: def.action as PermissionAction,
        name: def.name,
        description: def.description,
        isNav: def.isNav,
        sortOrder: def.sortOrder,
      },
      select: { id: true, key: true },
    });
    idByKey.set(record.key, record.id);
  }

  // 清理：代码中已删除、但库中仍存在的权限（连带 role_permissions 级联删除）
  const removed = await prisma.permission.deleteMany({
    where: { key: { notIn: [...idByKey.keys()] } },
  });
  if (removed.count > 0) {
    console.log(`[seed:rbac] 已清理 ${removed.count} 个已下线权限`);
  }

  console.log(`[seed:rbac] 权限清单已同步: ${idByKey.size} 项`);
  return idByKey;
}

/** 2. 创建内置系统角色并绑定预设权限 */
export async function seedBuiltinRoles(
  prisma: PrismaClient,
  permissionIdByKey: Map<string, string>,
): Promise<Map<string, string>> {
  const roleIdByKey = new Map<string, string>();

  for (const role of BUILTIN_ROLES) {
    assertPermissionKeys(role.key, role.permissions);

    const record = await prisma.role.upsert({
      where: { key: role.key },
      update: {
        name: role.name,
        description: role.description,
        sortOrder: role.sortOrder,
        isSystem: role.isSystem,
        // 内置角色状态强制 ACTIVE：受保护角色不允许被停用
        status: RoleStatus.ACTIVE,
      },
      create: {
        key: role.key,
        name: role.name,
        description: role.description,
        sortOrder: role.sortOrder,
        isSystem: role.isSystem,
        status: RoleStatus.ACTIVE,
      },
      select: { id: true, key: true },
    });
    roleIdByKey.set(record.key, record.id);

    // 权限绑定：受保护超管不落 role_permissions（代码恒等于全集）
    // 其他内置角色：**增量补齐预设**——只新增缺失的预设权限，
    // 不删除管理员后续手工授予的权限（避免覆盖手工调整）
    if (role.key === SUPER_ADMIN_ROLE_KEY || role.permissions.length === 0) continue;

    const bound = await prisma.rolePermission.findMany({
      where: { roleId: record.id },
      select: { permissionId: true },
    });
    const boundIds = new Set(bound.map((b) => b.permissionId));

    const missingIds: string[] = [];
    for (const key of role.permissions) {
      const permissionId = permissionIdByKey.get(key);
      if (permissionId && !boundIds.has(permissionId)) {
        missingIds.push(permissionId);
      }
    }

    if (missingIds.length > 0) {
      await prisma.rolePermission.createMany({
        data: missingIds.map((permissionId) => ({ roleId: record.id, permissionId })),
        skipDuplicates: true,
      });
      console.log(
        `[seed:rbac] ${role.key} 补充预设权限 ${missingIds.length} 项`,
      );
    }
  }

  console.log(`[seed:rbac] 内置角色已就绪: ${[...roleIdByKey.keys()].join(', ')}`);
  return roleIdByKey;
}

/**
 * 3. 迁移历史角色枚举 → admin_user_roles。
 * 只处理**尚无任何新角色关联**的账号（幂等，且不覆盖后续手工调整）。
 */
export async function migrateLegacyRoles(
  prisma: PrismaClient,
  roleIdByKey: Map<string, string>,
): Promise<void> {
  const superAdminId = roleIdByKey.get(SUPER_ADMIN_ROLE_KEY);
  const contentEditorId = roleIdByKey.get('CONTENT_EDITOR');
  if (!superAdminId || !contentEditorId) {
    throw new Error('[seed:rbac] 缺少 SUPER_ADMIN / CONTENT_EDITOR 角色，无法迁移历史账号');
  }

  const admins = await prisma.adminUser.findMany({
    select: { id: true, email: true, role: true, _count: { select: { userRoles: true } } },
  });

  let migrated = 0;
  for (const admin of admins) {
    // 已有新角色关联 → 属于 Phase 4.6 之后的数据，跳过
    if (admin._count.userRoles > 0) continue;

    // ADMIN → SUPER_ADMIN；EDITOR → CONTENT_EDITOR（不升权）
    const roleId = admin.role === 'ADMIN' ? superAdminId : contentEditorId;
    await prisma.adminUserRole.create({ data: { adminUserId: admin.id, roleId } });
    migrated += 1;
  }

  console.log(
    migrated > 0
      ? `[seed:rbac] 已迁移 ${migrated} 个历史账号角色（ADMIN→超级管理员，EDITOR→内容编辑）`
      : '[seed:rbac] 历史账号角色已全部迁移，无需处理',
  );

  // 自检：受保护角色必须存在且启用
  const protectedRoles = await prisma.role.findMany({
    where: { key: { in: [...PROTECTED_ROLE_KEYS] } },
    select: { key: true, status: true },
  });
  for (const key of PROTECTED_ROLE_KEYS) {
    const found = protectedRoles.find((r) => r.key === key);
    if (!found) throw new Error(`[seed:rbac] 受保护角色缺失: ${key}`);
    if (found.status !== RoleStatus.ACTIVE) {
      throw new Error(`[seed:rbac] 受保护角色状态异常: ${key} = ${found.status}`);
    }
  }
}
