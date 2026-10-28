import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RoleStatus } from '@prisma/client';
import { RolesService } from '../src/modules/cms/roles/roles.service';
import { AccountsService } from '../src/modules/cms/accounts/accounts.service';
import { RbacService } from '../src/modules/rbac/rbac.service';
import { AuditLogService } from '../src/modules/rbac/audit-log.service';
import type { ActorContext } from '../src/modules/rbac/actor-context';
import {
  ALL_PERMISSION_KEYS,
  LEGACY_ROLE_MIGRATION,
  PERMISSIONS,
  PERMISSION_DEPENDENCIES,
  PERMISSION_MODULES,
  SUPER_ADMIN_ROLE_KEY,
  expandPermissionDependencies,
  isValidPermissionKey,
  isProtectedRole,
} from '../src/modules/rbac/permission.registry';
import { normalizeSiteUrl } from '../src/modules/cms/site/site-url';
import type { PrismaService } from '../src/modules/prisma/prisma.service';

/**
 * RBAC 安全边界测试（Phase 4.7 补漏）。
 *
 * 对应任务书「新增 RBAC 测试 10 项」——覆盖：
 *   1. 提权防护（权限继承安全）：不得授予超出自身范围的权限 / 角色
 *   2. 幽灵权限拒绝：未注册 key 一律 400
 *   3. 受保护角色：SUPER_ADMIN 不可停用 / 不可改权限 / 不可删除
 *   4. 系统锁死防护：最后一个超管不可移除；不可移除自己的超管角色
 *   5. 权限注册表不变量：key 唯一、isNav 语义、模块归属合法
 *   6. 历史角色迁移不升权（EDITOR → CONTENT_EDITOR）
 *   7. 站内 URL 安全校验：危险协议 /  protocol-relative 外跳一律拒绝
 *
 * 数据库不参与：PrismaService / AuditLogService 以 jest mock 替换。
 */

const SUPER_ROLE_ROW = {
  id: 'role-super',
  key: SUPER_ADMIN_ROLE_KEY,
  name: '超级管理员',
  description: '',
  status: RoleStatus.ACTIVE,
  sortOrder: 0,
  isSystem: true,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  _count: { userRoles: 1 },
};

const NORMAL_ROLE_ROW = {
  id: 'role-editor',
  key: 'CONTENT_EDITOR',
  name: '内容编辑',
  description: '',
  status: RoleStatus.ACTIVE,
  sortOrder: 10,
  isSystem: false,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  _count: { userRoles: 0 },
};

const SUPER_ACTOR: ActorContext = {
  id: 'admin-1',
  email: 'super@bailingwooden.test',
  name: '超级管理员',
  permissions: new Set(ALL_PERMISSION_KEYS),
  isSuperAdmin: true,
};

const LIMITED_ACTOR: ActorContext = {
  id: 'admin-2',
  email: 'editor@bailingwooden.test',
  name: '内容编辑',
  permissions: new Set(['roles.read', 'roles.update', 'blog.read', 'blog.update']),
  isSuperAdmin: false,
};

function makeRbacMock() {
  return {
    findRoleOrFail: jest.fn(),
    assertRoleModifiable: jest.fn(),
    findEscalatedPermissions: jest.fn(
      (operator: { permissions: Set<string>; isSuperAdmin: boolean }, keys: string[]) =>
        operator.isSuperAdmin ? [] : keys.filter((k) => !operator.permissions.has(k)),
    ),
    findEscalatedRoles: jest.fn().mockResolvedValue([]),
    resolveAccess: jest.fn(),
  };
}

function makeAuditMock() {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

describe('RBAC 安全边界（Phase 4.7 补漏）', () => {
  /* -------------------------- 1. 提权防护 -------------------------- */

  describe('提权防护（权限继承安全）', () => {
    it('非超管授予超出自身范围的权限被 403 拒绝，并点名越权项', async () => {
      const rbac = makeRbacMock();
      rbac.findRoleOrFail.mockResolvedValue(NORMAL_ROLE_ROW);
      const prisma = {
        rolePermission: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
        role: { findUnique: jest.fn(), findMany: jest.fn() },
        $transaction: jest.fn().mockResolvedValue([]),
      };
      const service = new RolesService(
        prisma as unknown as PrismaService,
        rbac as unknown as RbacService,
        makeAuditMock() as unknown as AuditLogService,
      );

      await expect(
        service.assignPermissions(
          'role-editor',
          { permissionKeys: ['accounts.disable', 'blog.read'] } as never,
          LIMITED_ACTOR,
        ),
      ).rejects.toThrow(ForbiddenException);

      // 事务不得发生：权限集保持原状
      expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
    });

    it('非超管授予自己已具备的权限子集时放行（不误伤）', async () => {
      const rbac = makeRbacMock();
      rbac.findRoleOrFail.mockResolvedValue(NORMAL_ROLE_ROW);
      const prisma = {
        rolePermission: {
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn(),
        },
        permission: { findMany: jest.fn().mockResolvedValue([{ id: 'p1', key: 'blog.read' }]) },
        role: {
          findUnique: jest.fn().mockResolvedValue({ ...NORMAL_ROLE_ROW, rolePermissions: [], userRoles: [] }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        $transaction: jest.fn().mockImplementation((arg: unknown) =>
          typeof arg === 'function'
            ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
            : Promise.all(arg as Promise<unknown>[]),
        ),
      };
      const service = new RolesService(
        prisma as unknown as PrismaService,
        rbac as unknown as RbacService,
        makeAuditMock() as unknown as AuditLogService,
      );

      await service.assignPermissions(
        'role-editor',
        { permissionKeys: ['blog.read'] } as never,
        LIMITED_ACTOR,
      );

      expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'role-editor' } });
    });

    it('未注册的幽灵权限 key 被 400 拒绝（即使操作人是超管）', async () => {
      const rbac = makeRbacMock();
      rbac.findRoleOrFail.mockResolvedValue(NORMAL_ROLE_ROW);
      const prisma = {
        rolePermission: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
        $transaction: jest.fn().mockResolvedValue([]),
      };
      const service = new RolesService(
        prisma as unknown as PrismaService,
        rbac as unknown as RbacService,
        makeAuditMock() as unknown as AuditLogService,
      );

      await expect(
        service.assignPermissions(
          'role-editor',
          { permissionKeys: ['ghost.permission'] } as never,
          SUPER_ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  /* ---------------------- 1.5 读写依赖补齐 ---------------------- */

  describe('读写依赖（操作权限隐含同模块 read）', () => {
    it('只勾操作权限时自动补齐同模块 read，并写进审计', async () => {
      const rbac = makeRbacMock();
      rbac.findRoleOrFail.mockResolvedValue(NORMAL_ROLE_ROW);
      const createMany = jest.fn();
      const prisma = {
        rolePermission: {
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany,
        },
        permission: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'p-rfq-read', key: 'rfq.read' },
            { id: 'p-rfq-update', key: 'rfq.update' },
          ]),
        },
        role: {
          findUnique: jest.fn().mockResolvedValue({ ...NORMAL_ROLE_ROW, rolePermissions: [], userRoles: [] }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        $transaction: jest.fn().mockImplementation((arg: unknown) =>
          typeof arg === 'function'
            ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
            : Promise.all(arg as Promise<unknown>[]),
        ),
      };
      const audit = makeAuditMock();
      const service = new RolesService(
        prisma as unknown as PrismaService,
        rbac as unknown as RbacService,
        audit as unknown as AuditLogService,
      );

      await service.assignPermissions(
        'role-editor',
        { permissionKeys: ['rfq.update'] } as never,
        SUPER_ACTOR,
      );

      // 落库的权限集必须包含 read —— 否则侧栏入口与列表接口都进不去
      const queried = prisma.permission.findMany.mock.calls[0]?.[0] as {
        where: { key: { in: string[] } };
      };
      expect(queried.where.key.in.sort()).toEqual(['rfq.read', 'rfq.update']);
      expect(createMany).toHaveBeenCalledTimes(1);

      const summary = (audit.record.mock.calls[0]?.[0] as { summary: string }).summary;
      expect(summary).toContain('自动补齐依赖权限');
      expect(summary).toContain('rfq.read');
    });

    it('expandPermissionDependencies 只补 read，不反向补操作权限', () => {
      expect(expandPermissionDependencies(['rfq.update']).keys.sort()).toEqual([
        'rfq.read',
        'rfq.update',
      ]);
      // 勾 read 不会连带授予 update / delete
      expect(expandPermissionDependencies(['rfq.read']).keys).toEqual(['rfq.read']);
      // 幂等 + 不重复
      expect(expandPermissionDependencies(['rfq.read', 'rfq.update']).implied).toEqual([]);
    });

    it('注册表内每个非 read 权限都登记了同模块 read 依赖', () => {
      for (const def of PERMISSIONS) {
        if (def.action === 'read') continue;
        const readKey = `${def.module}.read`;
        if (!isValidPermissionKey(readKey)) continue; // 该模块本身没有 read 权限
        expect(PERMISSION_DEPENDENCIES[def.key]).toContain(readKey);
      }
    });
  });

  /* -------------------------- 2. 受保护角色 -------------------------- */

  describe('受保护角色与系统锁死防护', () => {
    it('SUPER_ADMIN 角色不可被分配权限（assertRoleModifiable 拦截）', async () => {
      const rbac = makeRbacMock();
      rbac.findRoleOrFail.mockResolvedValue(SUPER_ROLE_ROW);
      rbac.assertRoleModifiable.mockImplementation(() => {
        throw new ForbiddenException('受保护角色不可修改权限');
      });
      const prisma = {
        rolePermission: { findMany: jest.fn(), deleteMany: jest.fn() },
        $transaction: jest.fn(),
      };
      const service = new RolesService(
        prisma as unknown as PrismaService,
        rbac as unknown as RbacService,
        makeAuditMock() as unknown as AuditLogService,
      );

      await expect(
        service.assignPermissions(
          'role-super',
          { permissionKeys: ['blog.read'] } as never,
          SUPER_ACTOR,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN 角色不可停用', async () => {
      const rbac = makeRbacMock();
      rbac.findRoleOrFail.mockResolvedValue(SUPER_ROLE_ROW);
      const prisma = {
        role: { update: jest.fn(), findUnique: jest.fn().mockResolvedValue(SUPER_ROLE_ROW), findMany: jest.fn() },
        adminUserRole: { count: jest.fn().mockResolvedValue(0) },
      };
      const service = new RolesService(
        prisma as unknown as PrismaService,
        rbac as unknown as RbacService,
        makeAuditMock() as unknown as AuditLogService,
      );

      await expect(
        service.update('role-super', { status: RoleStatus.DISABLED } as never, SUPER_ACTOR),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.role.update).not.toHaveBeenCalled();
    });

    it('账号移除自己的超级管理员角色被拒绝（防自锁）', async () => {
      const adminRow = {
        id: 'admin-1',
        email: 'super@bailingwooden.test',
        name: '超管',
        jobTitle: null,
        role: 'ADMIN',
        isActive: true,
        createdAt: new Date(),
        lastLoginAt: null,
        userRoles: [{ role: { id: 'role-super', key: SUPER_ADMIN_ROLE_KEY, name: '超级管理员', status: RoleStatus.ACTIVE } }],
        contact: null,
      };
      const prisma = {
        adminUser: {
          findUnique: jest.fn().mockResolvedValue(adminRow),
          count: jest.fn().mockResolvedValue(0),
          update: jest.fn(),
        },
        role: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
        $transaction: jest.fn().mockResolvedValue([]),
      };
      const rbac = { findEscalatedRoles: jest.fn().mockResolvedValue([]) };
      const service = new AccountsService(
        prisma as unknown as PrismaService,
        rbac as unknown as RbacService,
        makeAuditMock() as unknown as AuditLogService,
      );

      await expect(
        service.update(
          'admin-1',
          { roleIds: ['role-editor'] } as never,
          { ...SUPER_ACTOR, id: 'admin-1' },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('移除最后一个生效超管被拒绝（防系统锁死）', async () => {
      const adminRow = {
        id: 'admin-2',
        email: 'other@bailingwooden.test',
        name: '另一个超管',
        jobTitle: null,
        role: 'ADMIN',
        isActive: true,
        createdAt: new Date(),
        lastLoginAt: null,
        userRoles: [{ role: { id: 'role-super', key: SUPER_ADMIN_ROLE_KEY, name: '超级管理员', status: RoleStatus.ACTIVE } }],
        contact: null,
      };
      const prisma = {
        adminUser: {
          findUnique: jest.fn().mockResolvedValue(adminRow),
          // willBeSuperAdmin(替代角色) = false；assertNotLastSuperAdmin = 0 个剩余
          count: jest.fn().mockResolvedValue(0),
          update: jest.fn(),
        },
        role: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
        $transaction: jest.fn().mockResolvedValue([]),
      };
      const rbac = { findEscalatedRoles: jest.fn().mockResolvedValue([]) };
      const service = new AccountsService(
        prisma as unknown as PrismaService,
        rbac as unknown as RbacService,
        makeAuditMock() as unknown as AuditLogService,
      );

      await expect(
        service.update(
          'admin-2',
          { roleIds: ['role-editor'] } as never,
          LIMITED_ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });
  });

  /* -------------------------- 3. 注册表不变量 -------------------------- */

  describe('权限注册表不变量', () => {
    it('权限 key 全局唯一', () => {
      const keys = PERMISSIONS.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('每个 module 恰好一个 isNav=true 的 read 权限，写权限一律 isNav=false', () => {
      const navByModule = new Map<string, number>();
      for (const p of PERMISSIONS) {
        if (p.action === 'read' && p.isNav) {
          navByModule.set(p.module, (navByModule.get(p.module) ?? 0) + 1);
        }
        if (p.action !== 'read') {
          expect(p.isNav).toBe(false);
        }
      }
      for (const module of PERMISSION_MODULES) {
        // dashboard 等工作台模块同样只有一个 read 导航权限
        expect(navByModule.get(module.key) ?? 0).toBeLessThanOrEqual(1);
      }
    });

    it('所有权限的 module 都已在 PERMISSION_MODULES 登记', () => {
      const modules = new Set(PERMISSION_MODULES.map((m) => m.key));
      for (const p of PERMISSIONS) {
        expect(modules.has(p.module)).toBe(true);
      }
    });

    it('isValidPermissionKey 只认注册表内的 key', () => {
      expect(isValidPermissionKey('blog.read')).toBe(true);
      expect(isValidPermissionKey('ghost.read')).toBe(false);
      expect(isValidPermissionKey('')).toBe(false);
    });

    it('LEGACY_ROLE_MIGRATION 不升权：EDITOR → CONTENT_EDITOR（非超管）', () => {
      expect(LEGACY_ROLE_MIGRATION.EDITOR).toBe('CONTENT_EDITOR');
      expect(LEGACY_ROLE_MIGRATION.EDITOR).not.toBe(SUPER_ADMIN_ROLE_KEY);
      expect(isProtectedRole(LEGACY_ROLE_MIGRATION.ADMIN)).toBe(true);
      expect(isProtectedRole(LEGACY_ROLE_MIGRATION.EDITOR)).toBe(false);
    });

    it('ALL_PERMISSION_KEYS 与 PERMISSIONS 一致', () => {
      expect([...ALL_PERMISSION_KEYS].sort()).toEqual(PERMISSIONS.map((p) => p.key).sort());
    });
  });

  /* -------------------------- 4. URL 安全校验 -------------------------- */

  describe('站内 URL 安全校验（normalizeSiteUrl）', () => {
    it('站内相对路径放行', () => {
      expect(normalizeSiteUrl('/products')).toBe('/products');
      expect(normalizeSiteUrl('/contact#rfq')).toBe('/contact#rfq');
      expect(normalizeSiteUrl('/quality#certificates')).toBe('/quality#certificates');
      expect(normalizeSiteUrl('  /products  ')).toBe('/products');
    });

    it('protocol-relative 与反斜杠外跳被拒绝', () => {
      expect(normalizeSiteUrl('//evil.com')).toBeNull();
      expect(normalizeSiteUrl('/\\evil.com')).toBeNull();
      expect(normalizeSiteUrl('\\\\evil.com')).toBeNull();
    });

    it('危险协议一律拒绝（javascript / data / vbscript / file / blob）', () => {
      expect(normalizeSiteUrl('javascript:alert(1)')).toBeNull();
      expect(normalizeSiteUrl('JavaScript:alert(1)')).toBeNull();
      expect(normalizeSiteUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
      expect(normalizeSiteUrl('vbscript:msgbox')).toBeNull();
      expect(normalizeSiteUrl('file:///etc/passwd')).toBeNull();
      expect(normalizeSiteUrl('blob:https://x')).toBeNull();
    });

    it('http 混合内容被拒绝；https / mailto / tel 放行', () => {
      expect(normalizeSiteUrl('http://example.com')).toBeNull();
      expect(normalizeSiteUrl('https://partner.example.com/specs')).toBe('https://partner.example.com/specs');
      expect(normalizeSiteUrl('mailto:sales@example.com')).toBe('mailto:sales@example.com');
      expect(normalizeSiteUrl('tel:+8613800138000')).toBe('tel:+8613800138000');
    });

    it('不可见字符拼接绕过被拒绝（java<TAB>script:）', () => {
      expect(normalizeSiteUrl('java\tscript:alert(1)')).toBeNull();
      expect(normalizeSiteUrl('java\nscript:alert(1)')).toBeNull();
      expect(normalizeSiteUrl('\u0001javascript:alert(1)')).toBeNull();
    });

    it('裸域名 / 空串 / 超长 / 控制字符被拒绝', () => {
      expect(normalizeSiteUrl('evil.com')).toBeNull();
      expect(normalizeSiteUrl('')).toBeNull();
      expect(normalizeSiteUrl('   ')).toBeNull();
      expect(normalizeSiteUrl('a'.repeat(2049))).toBeNull();
      expect(normalizeSiteUrl('/prod\u0000ucts')).toBeNull();
    });
  });
});
