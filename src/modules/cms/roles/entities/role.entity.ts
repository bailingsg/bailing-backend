import type { RoleStatus } from '@prisma/client';

/** 角色列表项 */
export interface RoleListItemDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: RoleStatus;
  /** 受保护的系统角色（不可停用/改权限/删除） */
  isProtected: boolean;
  isSystem: boolean;
  sortOrder: number;
  /** 关联员工账号数 */
  userCount: number;
  /** 已授予权限数（超管为权限全集大小） */
  permissionCount: number;
  /** 权限总数（前端显示 x/N） */
  totalPermissions: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 分页角色列表 */
export interface PaginatedRolesDto {
  items: RoleListItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** 角色详情（含权限 key 列表） */
export interface RoleDetailDto extends RoleListItemDto {
  /** 已授予的权限 key */
  permissions: string[];
  /** 关联员工摘要（便于前端提示「停用前请先调整」） */
  users: { id: string; email: string; name: string | null; isActive: boolean }[];
}

/** 权限定义（前端权限矩阵数据源） */
export interface PermissionDto {
  key: string;
  module: string;
  action: string;
  name: string;
  description: string;
  isNav: boolean;
  sortOrder: number;
}

/** 权限模块分组 */
export interface PermissionModuleDto {
  key: string;
  name: string;
  sortOrder: number;
  permissions: PermissionDto[];
}

/** 权限矩阵（模块分组 + 扁平列表） */
export interface PermissionMatrixDto {
  modules: PermissionModuleDto[];
  total: number;
}

/** 创建角色结果 */
export interface CreateRoleResultDto {
  id: string;
  key: string;
  name: string;
}

/** 角色操作类型（用于审计摘要） */
export type RoleAuditAction =
  | 'role.create'
  | 'role.update'
  | 'role.permissions.update'
  | 'role.disable'
  | 'role.enable'
  | 'role.delete';
