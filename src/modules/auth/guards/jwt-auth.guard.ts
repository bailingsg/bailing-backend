import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * JWT 认证守卫。
 *
 * 用于保护所有 CMS 后台接口（如 GET /api/v1/cms/stats）：
 *   · 无 Authorization 头 / 格式非 Bearer / 签名无效 / 已过期 → 401
 *
 * 与 Phase 3.7 的 AdminTokenGuard（X-Admin-Token 共享密钥）相互独立：
 * RFQ 后台接口继续兼容 X-Admin-Token，本守卫不改动其行为。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
