import { AdminRole } from '@prisma/client';
import type { AdminUser } from '@prisma/client';

/** 登录成功响应（accessToken + 当前用户摘要） */
export interface LoginResponseDto {
  accessToken: string;
  user: AdminProfileDto;
}

/**
 * 管理员公开档案（禁止外泄 passwordHash）。
 *
 * Phase 4.6 扩展：
 *   · roles      —— 生效角色 key 列表（新 RBAC 模型；旧 role 字段保留兼容）
 *   · permissions—— 生效权限 key 列表（前端据此决定菜单/按钮可见性）
 *   注意：permissions 仅用于**展示层**，真正的拦截在后端 PermissionsGuard。
 */
export interface AdminProfileDto {
  id: string;
  email: string;
  name: string | null;
  /** 兼容旧前端：旧枚举角色 */
  role: AdminRole;
  /** 新 RBAC 生效角色 key（可能为空） */
  roles: string[];
  /**
   * 生效角色的中文名（与 roles **同序同长**）。
   *
   * 角色 key 是英文标识（SALES），展示名在 roles.name（可被管理员改写）。
   * 前端要显示「销售」而不是「SALES」，又不能在前端硬编码 key→名 映射
   * （自建角色无对应条目、且改名后会漂移）——所以名称由后端随 key 一起下发。
   */
  roleNames: string[];
  /** 生效权限 key（超管为全集） */
  permissions: string[];
  /** 是否超级管理员 */
  isSuperAdmin: boolean;
  /** 职位（Phase 4.6） */
  jobTitle: string | null;
  /**
   * 我的头像地址（自助上传；未上传为 null）。
   *
   * 放在档案里而不是只放 /auth/profile 的 contact 段：顶栏要显示头像，
   * 而顶栏每页都会渲染，多调一次 /auth/profile 不划算。
   */
  avatarUrl: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
}

/**
 * 「我的联系方式」自助视图（GET/PATCH /auth/profile 的 contact 段）。
 *
 * 刻意**不含** internalNote / sortOrder / isLeadContact：
 * 那些是管理侧语义（内部备注、展示排序、询盘分配），员工自改会破坏审计与分配公平。
 */
export interface MyContactDto {
  displayName: string;
  jobTitle: string | null;
  displayEmail: string | null;
  whatsapp: string | null;
  phone: string | null;
  /**
   * 头像地址（自助上传，Phase 5.4 追加）。
   *
   * 由 avatarKey 经当前 StorageProvider 动态生成（取不到才回退快照），
   * 因此换存储后端/换 CDN 域名后地址仍然有效——与 contacts 列表同一口径。
   */
  avatarUrl: string | null;
  showOnSite: boolean;
}

/** 我的资料（账号档案 + 自己的联系方式） */
export interface MyProfileDto {
  profile: AdminProfileDto;
  /** 尚未创建联系方式时为 null（首次保存展示信息时自动创建） */
  contact: MyContactDto | null;
}

/**
 * AdminUser → 对外档案。
 * 显式挑选字段：passwordHash 等敏感列永不出现在响应中。
 */
export function toAdminProfile(admin: AdminUser): AdminProfileDto {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    roles: [],
    roleNames: [],
    permissions: [],
    isSuperAdmin: false,
    jobTitle: admin.jobTitle,
    avatarUrl: null,
    isActive: admin.isActive,
    lastLoginAt: admin.lastLoginAt,
  };
}
