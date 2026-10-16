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
  /** 生效权限 key（超管为全集） */
  permissions: string[];
  /** 是否超级管理员 */
  isSuperAdmin: boolean;
  /** 职位（Phase 4.6） */
  jobTitle: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
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
    permissions: [],
    isSuperAdmin: false,
    jobTitle: admin.jobTitle,
    isActive: admin.isActive,
    lastLoginAt: admin.lastLoginAt,
  };
}
