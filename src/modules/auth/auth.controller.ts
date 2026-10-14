import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AdminProfileDto, LoginResponseDto } from './auth.dto';
import type { AuthUser } from './auth.types';

/**
 * 管理员认证 API（Phase 4.1）。
 *
 *   POST /api/v1/auth/login   邮箱 + 口令 → JWT accessToken（公开）
 *   GET  /api/v1/auth/me      当前登录管理员（JWT 保护）
 *
 * 阶段约定：只实现 access token（默认 15m），不引入 refresh token。
 * 前端通过 HttpOnly Cookie 持有令牌（见 bailing-admin 登录路由）。
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 登录：成功返回 accessToken 与用户摘要；失败统一 401 */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }

  /** 当前用户：解析 Authorization: Bearer <token> */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() request: Request & { user: AuthUser }): Promise<AdminProfileDto> {
    return this.authService.me(request.user);
  }
}
