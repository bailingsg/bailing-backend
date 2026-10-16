import type { AdminRole } from '@prisma/client';

/** 账号列表项 —— 永不含 passwordHash */
export interface AccountListItemDto {
  id: string;
  name: string | null;
  email: string;
  jobTitle: string | null;
  /** 兼容旧前端 */
  role: AdminRole;
  /** 新 RBAC 角色（key + name） */
  roles: { id: string; key: string; name: string }[];
  isActive: boolean;
  /** 是否为受保护的系统超管账号（不可停用/降权/删除） */
  isProtected: boolean;
  /** 是否绑定员工联系方式 */
  hasContact: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

/** 分页账号列表 */
export interface PaginatedAccountsDto {
  items: AccountListItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** 账号详情 */
export interface AccountDetailDto extends AccountListItemDto {
  updatedAt: Date;
  /** 绑定联系方式的摘要（可空） */
  contact: {
    id: string;
    displayName: string;
    jobTitle: string | null;
    showOnSite: boolean;
    isLeadContact: boolean;
  } | null;
}

/** 创建账号结果（初始口令仅此处一次性返回，之后不可再取） */
export interface CreateAccountResultDto {
  account: AccountDetailDto;
  /**
   * 初始口令明文，**仅在创建响应中返回一次**。
   * 不入库、不写日志、不随其它接口返回；由操作人转交给员工。
   */
  initialPassword: string;
}

/** 可选角色（创建/编辑账号表单的下拉数据源） */
export interface AssignableRoleDto {
  id: string;
  key: string;
  name: string;
  /** 操作人是否有权分配（无权则前端禁用该选项） */
  assignable: boolean;
  /** 该角色含有的权限数（提示影响范围） */
  permissionCount: number;
}
