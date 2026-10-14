import { AdminRole } from '@prisma/client';
import type { AdminUser } from '@prisma/client';

/** 登录成功响应（accessToken + 当前用户摘要） */
export interface LoginResponseDto {
  accessToken: string;
  user: AdminProfileDto;
}

/** 管理员公开档案（禁止外泄 passwordHash） */
export interface AdminProfileDto {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
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
    isActive: admin.isActive,
    lastLoginAt: admin.lastLoginAt,
  };
}
