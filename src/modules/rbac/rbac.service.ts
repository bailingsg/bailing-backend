import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  LEGACY_ROLE_MIGRATION,
  PERMISSIONS,
  PROTECTED_ROLE_KEYS,
  SUPER_ADMIN_ROLE_KEY,
  isProtectedRole,
} from './permission.registry';

/** 解析结果：账号是否可用 + 该账号当前生效的权限集 */
export interface AccessContext {
  adminUserId: string;
  email: string;
  name: string | null;
  /** 是否启用 */
  isActive: boolean;
  /** 角色 key 列表（仅启用中的角色） */
  roleKeys: string[];
  /**
   * 角色中文名列表（与 roleKeys **同序同长**）。
   *
   * 为什么单独带一份 name：角色 key 是稳定的英文标识（SUPER_ADMIN / SALES），
   * 而展示名是可被管理员改写的（roles.name）。前端要显示「销售」而不是
   * 「SALES」，又不能在前端硬编码 key→名 映射表（会与库里的真实名称漂移，
   * 且自建角色根本没有对应条目）——所以名称必须由后端从库里取。
   */
  roleNames: string[];
  /** 生效权限 key 集合（仅启用中的角色所带权限） */
  permissions: Set<string>;
  /** 是否超级管理员（拥有全部权限） */
  isSuperAdmin: boolean;
  /**
   * 权限是否来自「旧角色枚举回退」（true = 该账号尚未被分配任何 RBAC 角色，
   * 按 legacy role 枚举兼容计算，不升权也不降级到零）。
   * 供后台提示「请为该账号分配角色」。
   */
  isLegacyFallback: boolean;
}

/**
 * RBAC 核心服务（Phase 4.6）。
 *
 * 职责：
 *   1. 把「账号 → 角色 → 权限」的解析集中到一处，避免各 Guard/Service 各写一套
 *   2. 每次调用都以**数据库实时状态**为准（账号停用、角色停用、权限变更立即生效）
 *   3. 提供权限比对、提权校验、受保护角色校验等安全原语
 *
 * 安全不变量：
 *   · 账号 isActive=false         → 无任何权限（AccessContext.isActive=false）
 *   · 角色 status=DISABLED        → 该角色不参与权限计算（立即失效）
 *   · SUPER_ADMIN 角色             → 恒等于权限全集（不受 role_permissions 影响）
 */
@Injectable()
export class RbacService {
  private readonly logger = new Logger(RbacService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 解析账号的实时访问上下文。
   * 账号不存在或已停用时返回 isActive=false + 空权限集（调用方决定抛 401 还是 403）。
   */
  async resolveAccess(adminUserId: string): Promise<AccessContext> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        role: true,
        userRoles: {
          select: {
            role: {
              select: {
                key: true,
                name: true,
                status: true,
                rolePermissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
      },
    });

    if (!admin) {
      return {
        adminUserId,
        email: '',
        name: null,
        isActive: false,
        roleKeys: [],
        roleNames: [],
        permissions: new Set<string>(),
        isSuperAdmin: false,
        isLegacyFallback: false,
      };
    }

    const roleKeys: string[] = [];
    const roleNames: string[] = [];
    const permissions = new Set<string>();
    let isSuperAdmin = false;

    for (const link of admin.userRoles) {
      const role = link.role;
      // 停用角色立即失效：不参与权限计算，也不计入角色列表
      if (role.status !== 'ACTIVE') continue;
      roleKeys.push(role.key);
      roleNames.push(role.name);
      if (role.key === SUPER_ADMIN_ROLE_KEY) {
        isSuperAdmin = true;
        continue;
      }
      for (const rp of role.rolePermissions) {
        permissions.add(rp.permission.key);
      }
    }

    // 超级管理员的权限集按定义恒等于全集（不依赖 role_permissions 数据）
    if (isSuperAdmin) {
      for (const def of PERMISSIONS) permissions.add(def.key);
    }

    /**
     * 兼容层：账号**完全没有**角色绑定时（例如 4.6 之前创建、尚未迁移的历史账号），
     * 按 legacy role 枚举计算权限，保持升级前的行为不变：
     *   ADMIN → SUPER_ADMIN、EDITOR → CONTENT_EDITOR（不升权、也不锁死）。
     *
     * 安全边界：只要存在**任意一条**角色绑定（哪怕已停用），就以显式 RBAC 状态为准，
     * 不再回退——否则「停用某账号全部角色」会被回退逻辑绕过。
     */
    let isLegacyFallback = false;
    if (admin.userRoles.length === 0) {
      const legacyKey = LEGACY_ROLE_MIGRATION[admin.role];
      if (legacyKey === SUPER_ADMIN_ROLE_KEY) {
        isLegacyFallback = true;
        roleKeys.push(legacyKey);
        isSuperAdmin = true;
        for (const def of PERMISSIONS) permissions.add(def.key);
        // 回退路径也要取到中文名（超级管理员是受保护角色，名称固定）
        const mapped = await this.prisma.role.findUnique({
          where: { key: legacyKey },
          select: { name: true },
        });
        roleNames.push(mapped?.name ?? '超级管理员');
      } else if (legacyKey) {
        // 与「显式分配该角色」完全等价：直接读库，不复制一份权限清单，避免与种子漂移
        const mapped = await this.prisma.role.findUnique({
          where: { key: legacyKey },
          select: {
            name: true,
            rolePermissions: { select: { permission: { select: { key: true } } } },
          },
        });
        if (mapped) {
          isLegacyFallback = true;
          roleKeys.push(legacyKey);
          roleNames.push(mapped.name);
          for (const rp of mapped.rolePermissions) permissions.add(rp.permission.key);
        }
      }
      if (isLegacyFallback) {
        this.logger.warn(
          `账号 ${admin.email} 尚未分配 RBAC 角色，按旧角色枚举 ${admin.role} → ${legacyKey} 兼容放行；` +
            '请在「角色与权限」中为其分配角色。',
        );
      }
    }

    return {
      adminUserId: admin.id,
      email: admin.email,
      name: admin.name,
      isActive: admin.isActive,
      roleKeys,
      roleNames,
      permissions,
      isSuperAdmin,
      isLegacyFallback,
    };
  }

  /** 账号当前生效权限 key 数组（排序后，供前端展示与导航计算） */
  async listEffectivePermissions(adminUserId: string): Promise<string[]> {
    const access = await this.resolveAccess(adminUserId);
    return [...access.permissions].sort();
  }

  /** 是否具备某权限 */
  hasPermission(access: AccessContext, permission: string): boolean {
    if (!access.isActive) return false;
    return access.permissions.has(permission);
  }

  /** 是否满足权限要求（all / any 模式） */
  satisfies(access: AccessContext, required: string[], mode: 'all' | 'any'): boolean {
    if (!access.isActive) return false;
    if (required.length === 0) return true;
    return mode === 'all'
      ? required.every((p) => access.permissions.has(p))
      : required.some((p) => access.permissions.has(p));
  }

  /**
   * 提权防护：操作人只能授予自己**已具备**的权限。
   * 返回越权授予的权限列表（空数组 = 合法）。
   *
   * 为什么必须做：即使前端禁用复选框，攻击者仍可直接伪造
   * PATCH /roles/:id { permissionIds: [...] } 请求。
   *
   * 形参用结构化子集（permissions / isSuperAdmin），
   * 便于 Service 层直接传 ActorContext，无需重复构造 AccessContext。
   */
  findEscalatedPermissions(
    operator: Pick<AccessContext, 'permissions' | 'isSuperAdmin'>,
    requestedKeys: string[],
  ): string[] {
    if (operator.isSuperAdmin) return [];
    return requestedKeys.filter((k) => !operator.permissions.has(k));
  }

  /**
   * 提权防护：操作人只能给账号分配自己**已具备**的角色权限范围。
   * 简化实现：超级管理员不受限；否则要求目标角色集合中每个角色
   * 的权限都是操作人权限的子集。
   */
  async findEscalatedRoles(
    operator: Pick<AccessContext, 'permissions' | 'isSuperAdmin'>,
    roleIds: string[],
  ): Promise<string[]> {
    if (operator.isSuperAdmin) return [];
    if (roleIds.length === 0) return [];

    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds } },
      select: {
        id: true,
        key: true,
        name: true,
        rolePermissions: { select: { permission: { select: { key: true } } } },
      },
    });

    const escalated: string[] = [];
    for (const role of roles) {
      if (role.key === SUPER_ADMIN_ROLE_KEY) {
        // 非超管分配超管角色 = 直接提权
        escalated.push(role.name);
        continue;
      }
      const beyond = role.rolePermissions
        .map((rp) => rp.permission.key)
        .filter((k) => !operator.permissions.has(k));
      if (beyond.length > 0) escalated.push(role.name);
    }
    return escalated;
  }

  /** 受保护角色校验（禁止停用/改权限/删除） */
  assertRoleModifiable(roleKey: string, operation: string): void {
    if (isProtectedRole(roleKey)) {
      throw new BadRequestException(
        `角色「${roleKey}」为受保护的系统角色，不允许${operation}。`,
      );
    }
  }

  /**
   * 旧角色枚举 → 新角色 key。
   * Phase 4.6 迁移用：ADMIN→SUPER_ADMIN，EDITOR→CONTENT_EDITOR（不升权）。
   */
  legacyRoleKey(legacy: 'ADMIN' | 'EDITOR'): string {
    return LEGACY_ROLE_MIGRATION[legacy];
  }

  /** 受保护角色 key 列表（供角色列表接口标记 isProtected） */
  protectedRoleKeys(): readonly string[] {
    return PROTECTED_ROLE_KEYS;
  }

  /** 取角色（不存在则 404） */
  async findRoleOrFail(roleId: string) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('角色不存在');
    return role;
  }
}
