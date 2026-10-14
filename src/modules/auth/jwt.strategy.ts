import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';
import type { AuthUser, JwtPayload } from './auth.types';

/**
 * JWT 策略（passport-jwt）。
 *
 * 职责：从 Authorization: Bearer <token> 解析并验签，
 * 通过后把 payload 映射为 AuthUser 挂到 request.user。
 *
 * 令牌只含 id / email / role（登录时签发），本策略不查库；
 * 停用账号的既有令牌最长存活到自然过期（默认 15m），
 * /auth/me 与后续 CMS 接口会以数据库实时状态为准做二次校验。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const options: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwtSecret'),
    };
    super(options);
  }

  /** 验签通过后回调：返回值挂载为 request.user */
  validate(payload: JwtPayload): AuthUser {
    if (!payload?.sub || !payload?.email) {
      throw new UnauthorizedException('Invalid token payload');
    }
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
