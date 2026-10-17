import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { RbacService } from '../rbac/rbac.service';
import {
  PERMISSIONS_METADATA_KEY,
  type RequiredPermissionsMetadata,
} from '../rbac/require-permissions.decorator';
import type { AuthUser, JwtPayload } from '../auth/auth.types';

/** 兼容通道请求头（Phase 3.7 服务间共享密钥） */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/**
 * RFQ 后台接口鉴权守卫（Phase 0）。
 *
 * 背景：Phase 3.7 的 AdminTokenGuard 在 `ADMIN_API_TOKEN` 未配置时**放行**（fail-open），
 * 生产漏配即等于客户询盘（姓名 / 邮箱 / 电话 / 需求正文）完全公开。
 *
 * 本守卫提供两条通道，且**任何一条都不允许 fail-open**：
 *
 *   1. JWT + RBAC（主通道，后台 UI 使用）
 *      · Authorization: Bearer <token> → 验签 → 实时查库（账号启用 / 角色状态）
 *      · 再按 @RequirePermissions 声明校验权限（rfq.read / rfq.update）
 *      · 令牌无效 / 账号停用 → 401；权限不足 → 403
 *
 *   2. X-Admin-Token（兼容通道，运维脚本 / 旧集成使用）
 *      · 仅在 ADMIN_API_TOKEN 已配置时启用；常量时间比较
 *      · 未配置（缺失 / 空串 / 纯空白）→ **503 fail-closed**，绝不放行
 *      · 令牌错误 → 401
 *
 * 兼容通道是「服务身份」，不参与 RBAC 权限计算；后台 UI 已全部迁移到 JWT 通道，
 * 因此即使运维未配置令牌，合法管理员也不会失去功能。
 */
@Injectable()
export class RfqAuthGuard implements CanActivate {
  private readonly logger = new Logger(RfqAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly rbac: RbacService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const authorization = request.headers.authorization;

    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      return this.authenticateJwt(context, request, authorization.slice(7).trim());
    }

    return this.authenticateServiceToken(request);
  }

  /** JWT 通道：验签 → 实时账号状态 → 权限声明 */
  private async authenticateJwt(
    context: ExecutionContext,
    request: Request & { user?: AuthUser },
    token: string,
  ): Promise<boolean> {
    if (token === '') {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    if (!payload?.sub || !payload.email) {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    // 与 PermissionsGuard 一致：以数据库实时状态为准，停用账号立即失效
    const access = await this.rbac.resolveAccess(payload.sub);
    if (!access.isActive) {
      throw new UnauthorizedException('账号已停用，请联系管理员');
    }

    request.user = { id: payload.sub, email: payload.email, role: payload.role };

    const required = this.reflector.getAllAndOverride<RequiredPermissionsMetadata | undefined>(
      PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    if (!this.rbac.satisfies(access, required.permissions, required.mode)) {
      const missing = required.permissions.filter((p) => !access.permissions.has(p));
      this.logger.warn(
        `权限不足: ${access.email} 访问 ${request.method} ${request.originalUrl} 缺少 [${missing.join(', ')}]`,
      );
      throw new ForbiddenException(`权限不足，缺少：${missing.join('、')}`);
    }

    return true;
  }

  /** 兼容通道：未配置令牌必须拒绝（fail-closed），而不是放行 */
  private authenticateServiceToken(request: Request): boolean {
    const expected = (this.config.get<string>('adminApiToken') ?? '').trim();

    if (expected === '') {
      this.logger.error(
        'ADMIN_API_TOKEN 未配置：后台 RFQ 兼容通道已拒绝访问（fail-closed）。' +
          '后台 UI 请使用 JWT 登录；如需服务间调用，请配置该环境变量。',
      );
      throw new ServiceUnavailableException(
        '服务端未配置 ADMIN_API_TOKEN，后台 RFQ 兼容通道已拒绝访问',
      );
    }

    const header = request.headers[ADMIN_TOKEN_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;

    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid or missing admin token');
    }
    return true;
  }
}

/** 常量时间比较，避免时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
