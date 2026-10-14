import type { AdminRole } from '@prisma/client';
import type { JwtSignOptions } from '@nestjs/jwt';

/**
 * 已认证管理员的上下文信息（由 JwtAuthGuard + JwtStrategy 注入 request.user）。
 * 仅包含鉴权必需字段，不携带 passwordHash 等敏感信息。
 */
export interface AuthUser {
  /** AdminUser.id */
  id: string;
  email: string;
  role: AdminRole;
}

/** JWT payload（与 AuthUser 对齐，sub 约定为主键 id） */
export interface JwtPayload {
  sub: string;
  email: string;
  role: AdminRole;
}

/**
 * Express Request 扩展：挂载鉴权用户。
 * 扩展 passport 的全局 Express.User 接口（声明合并），request.user 即 AuthUser。
 * 注意：User 的成员需与 AuthUser 保持一致（lint 规则不允许空接口）。
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User {
      /** AdminUser.id */
      id: string;
      email: string;
      role: AdminRole;
    }
  }
}

/** jsonwebtoken 的 expiresIn 类型（如 "15m" / "7d" / 3600） */
export type JwtExpiresIn = NonNullable<JwtSignOptions['expiresIn']>;

/** 环境变量字符串 → expiresIn 类型（格式已在 env.validation 校验） */
export function toExpiresIn(value: string): JwtExpiresIn {
  return value as unknown as JwtExpiresIn;
}
