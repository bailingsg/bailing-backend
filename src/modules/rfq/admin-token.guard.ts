import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** 后台接口鉴权请求头 */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/**
 * 后台接口的**最小保护**（不是权限系统）。
 *
 * 说明：
 *   · 本阶段按需求不开发登录 / 角色 / 权限体系（属后续阶段）；
 *   · 但 RFQ 列表与详情包含客户隐私（邮箱、电话、需求正文），
 *     若完全公开会造成数据泄漏，因此对**后台接口**加一道共享密钥校验。
 *   · 当环境变量 ADMIN_API_TOKEN 已配置时启用校验；未配置时放行并在启动日志告警
 *     （便于本地开发；生产环境必须配置，见 README）。
 *
 * 仅作用于 GET /rfq、GET /rfq/:id、PATCH /rfq/:id/status；
 * 公开的 POST /rfq 不受影响。
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  private readonly logger = new Logger(AdminTokenGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('adminApiToken') ?? '';

    // 未配置令牌：本地开发放行（生产必须配置）
    if (expected.trim() === '') {
      this.logger.warn(
        'ADMIN_API_TOKEN 未配置：后台 RFQ 接口当前无鉴权，仅可用于本地开发，生产环境必须配置。',
      );
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
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
