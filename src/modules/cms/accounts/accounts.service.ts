import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AdminRole, Prisma, RoleStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../rbac/audit-log.service';
import { RbacService } from '../../rbac/rbac.service';
import { hashPassword } from '../../auth/auth.service';
import type { ActorContext } from '../../rbac/actor-context';
import { SUPER_ADMIN_ROLE_KEY } from '../../rbac/permission.registry';
import {
  CreateAccountDto,
  ListAccountsQueryDto,
  ResetPasswordDto,
  SetAccountStatusDto,
  UpdateAccountDto,
} from './dto/account.dto';
import type {
  AccountDetailDto,
  AccountListItemDto,
  AssignableRoleDto,
  CreateAccountResultDto,
  PaginatedAccountsDto,
} from './entities/account.entity';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * 生成强随机初始口令（不传 initialPassword 时使用）。
 * 字符集剔除易混淆字符（0/O/1/l/I），长度 16，含大小写+数字+符号。
 * 口令只在创建/重置响应中一次性返回，**永不落库明文、永不写日志**。
 */
function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_=+';
  const all = upper + lower + digits + symbols;

  const pick = (set: string): string => set[randomBytes(1)[0] % set.length];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  for (let i = chars.length; i < 16; i += 1) chars.push(pick(all));
  // Fisher–Yates 洗牌，避免前四位的固定模式
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** 简易邮箱格式校验（与 DTO 的 IsString 互补；不引入额外依赖） */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 账号管理服务（Phase 4.6）。
 *
 * 安全不变量（全部在**后端**强制）：
 *   · 口令只以 bcrypt 哈希落库；明文仅在「创建/重置」响应中出现一次
 *   · 不能停用/降权/删除**最后一个生效的超级管理员**（防止系统锁死）
 *   · 不能停用**自己**、不能移除自己的超管角色（防止自锁）
 *   · 操作人只能分配自己已具备的角色（提权防护）
 *   · 所有重要变更写审计日志（actor/target/before-after/时间）
 *   · 停用账号 → 既有令牌在下一个受保护请求即失效（见 PermissionsGuard）
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly audit: AuditLogService,
  ) {}

  // ── 查询 ────────────────────────────────────────────────────

  async list(query: ListAccountsQueryDto): Promise<PaginatedAccountsDto> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE_SIZE)));
    const keyword = query.keyword?.trim();

    const where: Prisma.AdminUserWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.jobTitle ? { jobTitle: { equals: query.jobTitle, mode: 'insensitive' } } : {}),
      ...(query.roleId ? { userRoles: { some: { roleId: query.roleId } } } : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword, mode: 'insensitive' } },
              { email: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, admins] = await Promise.all([
      this.prisma.adminUser.count({ where }),
      this.prisma.adminUser.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, name: true, email: true, jobTitle: true, okkiAccount: true, alibabaAccount: true, role: true,
          isActive: true, createdAt: true, lastLoginAt: true,
          userRoles: { select: { role: { select: { id: true, key: true, name: true, status: true } } } },
          contact: { select: { id: true } },
        },
      }),
    ]);

    return {
      items: admins.map((a) => this.toListItem(a)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async findById(id: string): Promise<AccountDetailDto> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id },
      select: {
        id: true, name: true, email: true, jobTitle: true, okkiAccount: true, alibabaAccount: true, role: true,
        isActive: true, createdAt: true, updatedAt: true, lastLoginAt: true,
        userRoles: { select: { role: { select: { id: true, key: true, name: true, status: true } } } },
        contact: {
          select: { id: true, displayName: true, jobTitle: true, showOnSite: true, isLeadContact: true },
        },
      },
    });
    if (!admin) throw new NotFoundException('账号不存在');

    return {
      ...this.toListItem({ ...admin, contact: admin.contact ? { id: admin.contact.id } : null }),
      updatedAt: admin.updatedAt,
      contact: admin.contact ?? null,
    };
  }

  /**
   * 可分配角色列表（创建/编辑账号表单数据源）。
   * `assignable` 标记操作人是否有权分配该角色——前端据此禁用选项，
   * 但**真正的拒绝在后端**（见 assertRolesAssignable）。
   */
  async assignableRoles(actor: ActorContext): Promise<AssignableRoleDto[]> {
    const roles = await this.prisma.role.findMany({
      where: { status: RoleStatus.ACTIVE },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, key: true, name: true,
        rolePermissions: { select: { permission: { select: { key: true } } } },
      },
    });

    return roles.map((role) => {
      const isSuper = role.key === SUPER_ADMIN_ROLE_KEY;
      const assignable = actor.isSuperAdmin
        ? true
        : !isSuper && role.rolePermissions.every((rp) => actor.permissions.has(rp.permission.key));
      return {
        id: role.id,
        key: role.key,
        name: role.name,
        assignable,
        permissionCount: role.rolePermissions.length,
      };
    });
  }

  // ── 写入 ────────────────────────────────────────────────────

  /** 创建账号：校验邮箱唯一 → 校验角色可分配 → 哈希口令 → 建立角色关联 */
  async create(dto: CreateAccountDto, actor: ActorContext): Promise<CreateAccountResultDto> {
    const email = dto.email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }
    if (dto.roleIds.length === 0) {
      throw new BadRequestException('请至少为该账号分配一个角色');
    }

    const existing = await this.prisma.adminUser.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new ConflictException(`邮箱「${email}」已被占用，请更换。`);

    await this.assertRolesAssignable(actor, dto.roleIds);

    const plainPassword = dto.initialPassword?.trim() || generatePassword();
    const passwordHash = await hashPassword(plainPassword);

    const created = await this.prisma.$transaction(async (tx) => {
      const admin = await tx.adminUser.create({
        data: {
          email,
          name: dto.name.trim(),
          jobTitle: dto.jobTitle?.trim() || null,
          okkiAccount: dto.okkiAccount?.trim() || null,
          alibabaAccount: dto.alibabaAccount?.trim() || null,
          passwordHash,
          isActive: dto.isActive ?? true,
          // 兼容旧枚举：有超管角色则写 ADMIN，否则 EDITOR
          role: await this.deriveLegacyRole(tx, dto.roleIds),
        },
        select: { id: true },
      });
      await tx.adminUserRole.createMany({
        data: dto.roleIds.map((roleId) => ({ adminUserId: admin.id, roleId })),
        skipDuplicates: true,
      });
      return admin;
    });

    await this.audit.record({
      actor,
      action: 'account.create',
      targetType: 'AdminUser',
      targetId: created.id,
      summary: `创建账号「${dto.name.trim()}」(${email})，角色 ${dto.roleIds.length} 个`,
      // 注意：绝不记录口令（含明文与哈希）
      diff: {
        after: {
          email,
          name: dto.name.trim(),
          jobTitle: dto.jobTitle ?? null,
          okkiAccount: dto.okkiAccount ?? null,
          alibabaAccount: dto.alibabaAccount ?? null,
          roleIds: dto.roleIds,
        },
      },
    });

    this.logger.log(`账号已创建: ${email} by ${actor.email}`);

    return {
      account: await this.findById(created.id),
      // 明文口令仅此一次返回
      initialPassword: plainPassword,
    };
  }

  /** 更新账号基本信息与角色 */
  async update(id: string, dto: UpdateAccountDto, actor: ActorContext): Promise<AccountDetailDto> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id },
      select: {
        id: true, email: true, name: true, jobTitle: true, okkiAccount: true, alibabaAccount: true,
        userRoles: { select: { roleId: true, role: { select: { key: true } } } },
      },
    });
    if (!admin) throw new NotFoundException('账号不存在');

    const beforeRoleIds = admin.userRoles.map((ur) => ur.roleId);

    // 邮箱变更：唯一性检查
    let email: string | undefined;
    if (dto.email !== undefined) {
      email = dto.email.trim().toLowerCase();
      if (!EMAIL_REGEX.test(email)) throw new BadRequestException('邮箱格式不正确');
      if (email !== admin.email) {
        const dup = await this.prisma.adminUser.findUnique({ where: { email }, select: { id: true } });
        if (dup) throw new ConflictException(`邮箱「${email}」已被占用，请更换。`);
      }
    }

    const isSelf = id === actor.id;

    // 角色变更的三重防护
    if (dto.roleIds !== undefined) {
      if (dto.roleIds.length === 0) {
        throw new BadRequestException('请至少保留一个角色');
      }
      await this.assertRolesAssignable(actor, dto.roleIds);

      const wasSuperAdmin = admin.userRoles.some((ur) => ur.role.key === SUPER_ADMIN_ROLE_KEY);
      const willBeSuperAdmin = await this.willBeSuperAdmin(dto.roleIds);

      // 不能移除自己的超管角色（自锁）
      if (isSelf && wasSuperAdmin && !willBeSuperAdmin) {
        throw new BadRequestException('不能移除自己的超级管理员角色。');
      }
      // 不能移除最后一个超管（系统锁死）
      if (wasSuperAdmin && !willBeSuperAdmin) {
        await this.assertNotLastSuperAdmin(id);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(dto.jobTitle !== undefined ? { jobTitle: dto.jobTitle?.trim() || null } : {}),
          ...(dto.okkiAccount !== undefined ? { okkiAccount: dto.okkiAccount?.trim() || null } : {}),
          ...(dto.alibabaAccount !== undefined ? { alibabaAccount: dto.alibabaAccount?.trim() || null } : {}),
          ...(dto.roleIds !== undefined
            ? { role: await this.deriveLegacyRole(tx, dto.roleIds) }
            : {}),
        },
      });
      if (dto.roleIds !== undefined) {
        await tx.adminUserRole.deleteMany({ where: { adminUserId: id } });
        await tx.adminUserRole.createMany({
          data: dto.roleIds.map((roleId) => ({ adminUserId: id, roleId })),
          skipDuplicates: true,
        });
      }
    });

    await this.audit.record({
      actor,
      action: 'account.update',
      targetType: 'AdminUser',
      targetId: id,
      summary: `更新账号「${admin.name ?? admin.email}」${dto.roleIds ? '（含角色调整）' : ''}`,
      diff: {
        before: {
          email: admin.email,
          name: admin.name,
          jobTitle: admin.jobTitle,
          okkiAccount: admin.okkiAccount,
          alibabaAccount: admin.alibabaAccount,
          roleIds: beforeRoleIds,
        },
        after: {
          email: email ?? admin.email,
          name: dto.name?.trim() ?? admin.name,
          jobTitle: dto.jobTitle !== undefined ? dto.jobTitle?.trim() || null : admin.jobTitle,
          okkiAccount: dto.okkiAccount !== undefined ? dto.okkiAccount?.trim() || null : admin.okkiAccount,
          alibabaAccount:
            dto.alibabaAccount !== undefined ? dto.alibabaAccount?.trim() || null : admin.alibabaAccount,
          roleIds: dto.roleIds ?? beforeRoleIds,
        },
      },
    });

    return this.findById(id);
  }

  /** 启用 / 停用账号（含自我停用与最后超管防护） */
  async setStatus(
    id: string,
    dto: SetAccountStatusDto,
    actor: ActorContext,
  ): Promise<AccountDetailDto> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, isActive: true, userRoles: { select: { role: { select: { key: true } } } } },
    });
    if (!admin) throw new NotFoundException('账号不存在');

    if (admin.isActive === dto.isActive) {
      return this.findById(id); // 幂等：状态一致直接返回
    }

    if (!dto.isActive) {
      if (id === actor.id) {
        throw new BadRequestException('不能停用当前登录的账号。');
      }
      const isSuper = admin.userRoles.some((ur) => ur.role.key === SUPER_ADMIN_ROLE_KEY);
      if (isSuper) await this.assertNotLastSuperAdmin(id);
    }

    await this.prisma.adminUser.update({ where: { id }, data: { isActive: dto.isActive } });

    // 停用账号：员工联系方式自动停止公开展示、退出询盘分配队列（保留历史）
    // 这里同步联系方式展示开关；询盘队列由分配引擎实时按 isActive 过滤
    if (!dto.isActive) {
      await this.prisma.employeeContact.updateMany({
        where: { adminUserId: id, showOnSite: true },
        data: { showOnSite: false },
      });
    }

    await this.audit.record({
      actor,
      action: dto.isActive ? 'account.enable' : 'account.disable',
      targetType: 'AdminUser',
      targetId: id,
      summary: `${dto.isActive ? '启用' : '停用'}账号「${admin.name ?? admin.email}」(${admin.email})`,
      diff: { before: { isActive: admin.isActive }, after: { isActive: dto.isActive } },
    });

    this.logger.log(`账号${dto.isActive ? '启用' : '停用'}: ${admin.email} by ${actor.email}`);
    return this.findById(id);
  }

  /** 重置账号口令（明文仅本次返回） */
  async resetPassword(
    id: string,
    dto: ResetPasswordDto,
    actor: ActorContext,
  ): Promise<{ initialPassword: string }> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, email: true, name: true },
    });
    if (!admin) throw new NotFoundException('账号不存在');

    const plainPassword = dto.newPassword?.trim() || generatePassword();
    const passwordHash = await hashPassword(plainPassword);

    await this.prisma.adminUser.update({ where: { id }, data: { passwordHash } });

    await this.audit.record({
      actor,
      action: 'account.reset_password',
      targetType: 'AdminUser',
      targetId: id,
      summary: `重置账号「${admin.name ?? admin.email}」(${admin.email}) 的登录口令`,
      // 审计只记录「发生了重置」，绝不记录口令本身
      diff: { changed: 'passwordHash' },
    });

    this.logger.log(`账号口令已重置: ${admin.email} by ${actor.email}`);
    return { initialPassword: plainPassword };
  }

  // ── 内部防护 ────────────────────────────────────────────────

  /** 校验操作人是否有权分配这批角色（提权防护） */
  private async assertRolesAssignable(actor: ActorContext, roleIds: string[]): Promise<void> {
    const escalated = await this.rbac.findEscalatedRoles(actor, roleIds);
    if (escalated.length > 0) {
      throw new ForbiddenException(
        `不能分配超出自身权限范围的角色：${escalated.join('、')}`,
      );
    }
  }

  /** 给定角色 id 列表里是否包含超级管理员角色 */
  private async willBeSuperAdmin(roleIds: string[]): Promise<boolean> {
    const count = await this.prisma.role.count({
      where: { id: { in: roleIds }, key: SUPER_ADMIN_ROLE_KEY },
    });
    return count > 0;
  }

  /**
   * 断言「移除该账号的超管角色后，系统仍有其他生效的超管」。
   * 否则会锁死整个系统。
   */
  private async assertNotLastSuperAdmin(excludeAdminId: string): Promise<void> {
    const remaining = await this.prisma.adminUser.count({
      where: {
        isActive: true,
        id: { not: excludeAdminId },
        userRoles: { some: { role: { key: SUPER_ADMIN_ROLE_KEY, status: RoleStatus.ACTIVE } } },
      },
    });
    if (remaining === 0) {
      throw new BadRequestException(
        '系统中必须至少保留一个启用状态的超级管理员账号，该操作会导致无人可管理后台。',
      );
    }
  }

  /** 旧枚举兼容：含超管角色 → ADMIN，否则 EDITOR */
  private async deriveLegacyRole(
    tx: Prisma.TransactionClient,
    roleIds: string[],
  ): Promise<AdminRole> {
    const superCount = await tx.role.count({
      where: { id: { in: roleIds }, key: SUPER_ADMIN_ROLE_KEY },
    });
    return superCount > 0 ? AdminRole.ADMIN : AdminRole.EDITOR;
  }

  private toListItem(admin: {
    id: string; name: string | null; email: string; jobTitle: string | null;
    okkiAccount: string | null; alibabaAccount: string | null;
    role: AdminRole; isActive: boolean; createdAt: Date; lastLoginAt: Date | null;
    userRoles: { role: { id: string; key: string; name: string; status: RoleStatus } }[];
    contact: { id: string } | null;
  }): AccountListItemDto {
    const roles = admin.userRoles
      .map((ur) => ur.role)
      .filter((r) => r.status === RoleStatus.ACTIVE)
      .map((r) => ({ id: r.id, key: r.key, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      jobTitle: admin.jobTitle,
      okkiAccount: admin.okkiAccount ?? null,
      alibabaAccount: admin.alibabaAccount ?? null,
      role: admin.role,
      roles,
      isActive: admin.isActive,
      isProtected: roles.some((r) => r.key === SUPER_ADMIN_ROLE_KEY),
      hasContact: Boolean(admin.contact),
      createdAt: admin.createdAt,
      lastLoginAt: admin.lastLoginAt,
    };
  }
}
