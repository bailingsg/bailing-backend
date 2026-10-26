import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RbacService } from './rbac.service';
import {
  PERMISSIONS_METADATA_KEY,
  type RequiredPermissionsMetadata,
} from './require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';

/**
 * 权限守卫（Phase 4.6）。
 *
 * 执行顺序要求：@UseGuards(JwtAuthGuard, PermissionsGuard)
 *   · JwtAuthGuard 先验签 → request.user 有值
 *   · PermissionsGuard 再查库解析实时权限 → 403 / 放行
 *
 * 三重校验（缺一不可）：
 *   1. request.user 存在（未过 JwtAuthGuard 时直接 401）
 *   2. 账号在数据库中**仍然启用**（账号被停用后既有令牌立即失效，
 *      不再等待 12h 自然过期——这是 Phase 4.6 相对 4.1 的强化点）
 *   3. 账号权限满足 @RequirePermissions 声明
 *
 * 未声明权限的接口：只做「登录 + 账号启用」校验后放行。
 * 这是刻意的——避免为了通过 Guard 而给不需要权限的接口乱挂权限。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    if (!user?.id) {
      throw new UnauthorizedException('未登录或登录已失效');
    }

    const access = await this.rbac.resolveAccess(user.id);

    // 账号被删除 / 停用 → 既有令牌立即作废
    if (!access.isActive) {
      throw new UnauthorizedException('账号已停用，请联系管理员');
    }

    // 读取方法级优先、类级兜底的权限声明
    const required = this.reflector.getAllAndOverride<RequiredPermissionsMetadata | undefined>(
      PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    if (!this.rbac.satisfies(access, required.permissions, required.mode)) {
      const missing = required.permissions.filter((p) => !access.permissions.has(p));
      this.logger.warn(
        `权限不足: ${access.email} 访问 ${request.method} ${request.originalUrl} 缺少 [${missing.join(', ')}]`,
      );
      throw new ForbiddenException(
        `权限不足，缺少：${missing.join('、')}`,
      );
    }

    return true;
  }
}
