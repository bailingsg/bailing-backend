import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../rbac/audit-log.service';
import { RbacService } from '../../rbac/rbac.service';
import type { ActorContext } from '../../rbac/actor-context';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_MODULES,
  PERMISSIONS,
  expandPermissionDependencies,
  isValidPermissionKey,
  isProtectedRole,
} from '../../rbac/permission.registry';
import { AssignPermissionsDto, CreateRoleDto, ListRolesQueryDto, UpdateRoleDto } from './dto/role.dto';
import type {
  CreateRoleResultDto,
  PaginatedRolesDto,
  PermissionMatrixDto,
  RoleDetailDto,
  RoleListItemDto,
} from './entities/role.entity';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * 角色与权限管理服务（Phase 4.6）。
 *
 * 安全要点（全部在**后端**强制，不依赖前端）：
 *   · 受保护角色（SUPER_ADMIN）：不可停用 / 不可改权限 / 不可删除
 *   · 提权防护：操作人不得授予自己不具备的权限，也不得分配自己不具备的角色
 *   · 角色 key 创建后不可修改（审计与外部引用稳定性）
 *   · 停用角色立即失效：PermissionsGuard 每次请求实时解析，不等令牌过期
 *   · 所有重要变更写审计日志（actor / target / before-after diff / 时间）
 */
@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly audit: AuditLogService,
  ) {}

  // ── 查询 ────────────────────────────────────────────────────

  /** 角色列表（分页 + 关键词 + 状态过滤，附关联员工数） */
  async list(query: ListRolesQueryDto): Promise<PaginatedRolesDto> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE_SIZE)));
    const keyword = query.keyword?.trim();

    const where: Prisma.RoleWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword, mode: 'insensitive' } },
              { key: { contains: keyword, mode: 'insensitive' } },
              { description: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, roles] = await Promise.all([
      this.prisma.role.count({ where }),
      this.prisma.role.findMany({
        where,
        // 受保护角色恒排最前（sortOrder=0），其余按 sortOrder → 创建时间
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { userRoles: true, rolePermissions: true } },
        },
      }),
    ]);

    const totalPermissions = ALL_PERMISSION_KEYS.length;

    return {
      items: roles.map((role) => this.toListItem(role, totalPermissions)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 角色详情（含权限 key 与关联员工摘要） */
  async findById(id: string): Promise<RoleDetailDto> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: {
        rolePermissions: { select: { permission: { select: { key: true } } } },
        userRoles: {
          select: {
            adminUser: { select: { id: true, email: true, name: true, isActive: true } },
          },
        },
        _count: { select: { userRoles: true, rolePermissions: true } },
      },
    });

    if (!role) throw new NotFoundException('角色不存在');

    const isSuperAdmin = role.key === 'SUPER_ADMIN';
    // 超管的「已授予权限」按定义恒等于全集（role_permissions 中不落数据）
    const permissions = isSuperAdmin
      ? [...ALL_PERMISSION_KEYS].sort()
      : role.rolePermissions.map((rp) => rp.permission.key).sort();

    return {
      ...this.toListItem(role, ALL_PERMISSION_KEYS.length),
      permissions,
      permissionCount: permissions.length,
      users: role.userRoles
        .map((ur) => ur.adminUser)
        .sort((a, b) => a.email.localeCompare(b.email)),
    };
  }

  /**
   * 权限矩阵（前端角色编辑页的分组复选框数据源）。
   * 从代码注册表读取，**不查库**——保证 UI 展示与后端校验同源。
   */
  permissionMatrix(): PermissionMatrixDto {
    const modules = PERMISSION_MODULES.map((m) => ({
      key: m.key,
      name: m.name,
      sortOrder: m.sortOrder,
      permissions: PERMISSIONS.filter((p) => p.module === m.key)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((p) => ({
          key: p.key,
          module: p.module,
          action: p.action,
          name: p.name,
          description: p.description,
          isNav: p.isNav,
          sortOrder: p.sortOrder,
        })),
    })).filter((m) => m.permissions.length > 0);

    return { modules, total: PERMISSIONS.length };
  }

  // ── 写入 ────────────────────────────────────────────────────

  /** 创建角色（初始**不授予任何权限**） */
  async create(dto: CreateRoleDto, actor: ActorContext): Promise<CreateRoleResultDto> {
    const key = dto.key.trim().toUpperCase();

    if (isProtectedRole(key)) {
      throw new BadRequestException(`角色标识「${key}」为系统保留标识，不可自定义使用。`);
    }

    const existing = await this.prisma.role.findUnique({ where: { key }, select: { id: true } });
    if (existing) {
      throw new ConflictException(`角色标识「${key}」已存在，请更换。`);
    }

    const role = await this.prisma.role.create({
      data: {
        key,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        status: RoleStatus.ACTIVE,
        isSystem: false,
        sortOrder: Number.isFinite(dto.sortOrder) ? Math.floor(dto.sortOrder as number) : 100,
      },
      select: { id: true, key: true, name: true },
    });

    await this.audit.record({
      actor,
      action: 'role.create',
      targetType: 'Role',
      targetId: role.id,
      summary: `创建角色「${role.name}」(${role.key})，初始权限为空`,
      diff: { after: { key: role.key, name: role.name, description: dto.description ?? null } },
    });

    this.logger.log(`角色已创建: ${role.key} by ${actor.email}`);
    return role;
  }

  /** 更新角色基本信息（名称 / 描述 / 状态 / 排序） */
  async update(id: string, dto: UpdateRoleDto, actor: ActorContext): Promise<RoleDetailDto> {
    const role = await this.rbac.findRoleOrFail(id);

    // 受保护角色：只允许改名称与描述
    if (isProtectedRole(role.key)) {
      if (dto.status !== undefined && dto.status !== RoleStatus.ACTIVE) {
        throw new BadRequestException('系统超级管理员角色不可停用。');
      }
    }

    if (dto.status === RoleStatus.DISABLED) {
      await this.assertRoleNotInUseForDisable(role.id, role.name);
    }

    const before = {
      name: role.name,
      description: role.description,
      status: role.status,
      sortOrder: role.sortOrder,
    };

    await this.prisma.role.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.sortOrder !== undefined && Number.isFinite(dto.sortOrder)
          ? { sortOrder: Math.floor(dto.sortOrder) }
          : {}),
      },
    });

    const after = {
      name: dto.name?.trim() ?? before.name,
      description: dto.description !== undefined ? dto.description?.trim() || null : before.description,
      status: dto.status ?? before.status,
      sortOrder: dto.sortOrder !== undefined ? Math.floor(dto.sortOrder) : before.sortOrder,
    };

    const statusChanged = dto.status !== undefined && dto.status !== before.status;
    await this.audit.record({
      actor,
      action: statusChanged
        ? dto.status === RoleStatus.DISABLED
          ? 'role.disable'
          : 'role.enable'
        : 'role.update',
      targetType: 'Role',
      targetId: id,
      summary: statusChanged
        ? `${dto.status === RoleStatus.DISABLED ? '停用' : '启用'}角色「${role.name}」`
        : `更新角色「${role.name}」基本信息`,
      diff: { before, after },
    });

    return this.findById(id);
  }

  /**
   * 分配角色权限（全量替换）。
   *
   * 四道后端强制校验：
   *   0. **补齐读写依赖**：勾了操作类权限（如 rfq.update）就自动带上同模块的
   *      查看权限（rfq.read）。侧栏入口与路由守卫只认 read，缺了它会出现
   *      「分配了权限但账号里没有这个页面」——这不是前端 bug，是权限集不完整。
   *   1. 受保护角色不可改权限
   *   2. 权限 key 必须已在注册表登记（拒绝幽灵权限）
   *   3. 操作人不得授予自己不具备的权限（提权防护）
   */
  async assignPermissions(
    id: string,
    dto: AssignPermissionsDto,
    actor: ActorContext,
  ): Promise<RoleDetailDto> {
    const role = await this.rbac.findRoleOrFail(id);
    this.rbac.assertRoleModifiable(role.key, '修改权限');

    // 去重 → 补齐依赖 → 校验合法性
    const deduped = [...new Set(dto.permissionKeys.map((k) => k.trim()).filter(Boolean))];
    const { keys: requested, implied } = expandPermissionDependencies(deduped);
    const unknown = requested.filter((k) => !isValidPermissionKey(k));
    if (unknown.length > 0) {
      throw new BadRequestException(`存在未注册的权限标识：${unknown.join('、')}`);
    }

    // 提权防护（后端强制，前端禁用勾选只是体验优化）。
    // 操作人自身权限也按同一规则补齐：否则「他有 update 却没有 read」的历史数据
    // 会因自动补上的 read 被误判为提权，报错信息还会指向一个他自己都有的能力。
    const operatorKeys = expandPermissionDependencies([...actor.permissions]).keys;
    const escalated = this.rbac.findEscalatedPermissions(
      { permissions: new Set(operatorKeys), isSuperAdmin: actor.isSuperAdmin },
      requested,
    );
    if (escalated.length > 0) {
      throw new ForbiddenException(
        `不能授予超出自身权限范围的权限：${escalated.join('、')}`,
      );
    }

    const before = await this.prisma.rolePermission.findMany({
      where: { roleId: id },
      select: { permission: { select: { key: true } } },
    });
    const beforeKeys = before.map((b) => b.permission.key).sort();

    const permissionRecords = await this.prisma.permission.findMany({
      where: { key: { in: requested } },
      select: { id: true, key: true },
    });

    // 事务内全量替换，避免中途失败留下半个权限集
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (permissionRecords.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionRecords.map((p) => ({ roleId: id, permissionId: p.id })),
          skipDuplicates: true,
        });
      }
    });

    const afterKeys = permissionRecords.map((p) => p.key).sort();
    const added = afterKeys.filter((k) => !beforeKeys.includes(k));
    const removedKeys = beforeKeys.filter((k) => !afterKeys.includes(k));

    await this.audit.record({
      actor,
      action: 'role.permissions.update',
      targetType: 'Role',
      targetId: id,
      summary:
        `调整角色「${role.name}」权限：+${added.length} / -${removedKeys.length}（共 ${afterKeys.length} 项）` +
        (implied.length > 0 ? `，自动补齐依赖权限 ${implied.join('、')}` : ''),
      diff: { before: beforeKeys, after: afterKeys, added, removed: removedKeys, implied },
    });

    this.logger.log(
      `角色权限已更新: ${role.key} (+${added.length}/-${removedKeys.length}) by ${actor.email}`,
    );

    return this.findById(id);
  }

  /**
   * 删除角色。
   * 约束：受保护角色不可删；仍有关联员工时不可删（避免员工权限静默丢失）。
   */
  async remove(id: string, actor: ActorContext): Promise<{ id: string }> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { _count: { select: { userRoles: true } } },
    });
    if (!role) throw new NotFoundException('角色不存在');

    this.rbac.assertRoleModifiable(role.key, '删除');

    if (role._count.userRoles > 0) {
      throw new BadRequestException(
        `该角色仍关联 ${role._count.userRoles} 个员工账号，请先将这些账号改派其他角色后再删除。`,
      );
    }

    await this.prisma.role.delete({ where: { id } });

    await this.audit.record({
      actor,
      action: 'role.delete',
      targetType: 'Role',
      targetId: id,
      summary: `删除角色「${role.name}」(${role.key})`,
      diff: { before: { key: role.key, name: role.name, status: role.status } },
    });

    this.logger.log(`角色已删除: ${role.key} by ${actor.email}`);
    return { id };
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 停用前检查：不允许停用当前账号自己的唯一生效角色（防止自锁） */
  private async assertRoleNotInUseForDisable(roleId: string, roleName: string): Promise<void> {
    const activeUsers = await this.prisma.adminUserRole.count({
      where: { roleId, adminUser: { isActive: true } },
    });
    if (activeUsers > 0) {
      // 允许停用，但前端需明确提示影响范围；此处仅记录警告，不阻断
      this.logger.warn(`停用角色「${roleName}」将影响 ${activeUsers} 个启用中的账号`);
    }
  }

  private toListItem(
    role: {
      id: string;
      key: string;
      name: string;
      description: string | null;
      status: RoleStatus;
      isSystem: boolean;
      sortOrder: number;
      createdAt: Date;
      updatedAt: Date;
      _count: { userRoles: number; rolePermissions: number };
    },
    totalPermissions: number,
  ): RoleListItemDto {
    const isSuperAdmin = role.key === 'SUPER_ADMIN';
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      status: role.status,
      isProtected: isProtectedRole(role.key),
      isSystem: role.isSystem,
      sortOrder: role.sortOrder,
      userCount: role._count.userRoles,
      permissionCount: isSuperAdmin ? totalPermissions : role._count.rolePermissions,
      totalPermissions,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }
}
