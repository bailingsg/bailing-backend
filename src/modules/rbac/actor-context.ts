import type { AuthUser } from '../auth/auth.types';

/**
 * 当前操作人上下文（Phase 4.6）。
 *
 * ActorContext = JWT 中的身份（request.user）+ 数据库实时权限。
 * Service 层用它做审计（actor 是谁）和二次提权校验。
 *
 * 为什么 Service 还要再校验一次：Guard 校验的是「能否调用本接口」，
 * 而「能否对本条数据做该操作」属于业务语义（例如不能授予超出自身范围的权限、
 * 不能修改受保护角色），必须在 Service 内基于实际入参再判断。
 */
export interface ActorContext {
  /** 操作人 AdminUser.id */
  id: string;
  /** 操作人邮箱（审计用，避免二次查库） */
  email: string;
  /** 操作人姓名（可能为 null） */
  name: string | null;
  /** 操作人生效权限集 */
  permissions: Set<string>;
  /** 是否超级管理员 */
  isSuperAdmin: boolean;
}

/** 从 request.user + RbacService 解析结果构造 ActorContext */
export function toActorContext(user: AuthUser, access: {
  email: string;
  name: string | null;
  permissions: Set<string>;
  isSuperAdmin: boolean;
}): ActorContext {
  return {
    id: user.id,
    email: access.email,
    name: access.name,
    permissions: access.permissions,
    isSuperAdmin: access.isSuperAdmin,
  };
}
