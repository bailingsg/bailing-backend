import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import type { AuthUser, JwtExpiresIn, JwtPayload } from './auth.types';
import { LoginDto } from './dto/login.dto';
import type { AdminProfileDto, LoginResponseDto } from './auth.dto';

/**
 * bcrypt 成本因子。
 * 12 约 250ms（当代 CPU 单核），后台登录频次极低，可接受。
 */
export const BCRYPT_ROUNDS = 12;

/** 口令哈希（seed 与后续建号共用；禁止明文落库） */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** 口令校验 */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * 占位哈希：为「邮箱不存在」分支提供同等耗时的 bcrypt 比较，
 * 抹平账号枚举所需的响应时间差。随机生成、无法反推，进程级复用。
 */
const DUMMY_HASH: string = bcrypt.hashSync(`dummy-${Math.random().toString(36)}-${Date.now()}`, BCRYPT_ROUNDS);

/**
 * 管理员认证服务。
 *
 * 安全约定：
 *   · 数据库只存 passwordHash（bcrypt），禁止任何明文口令
 *   · 登录失败统一 401 "Invalid email or password"，
 *     不区分「邮箱不存在」与「口令错误」，避免账号枚举
 *   · 邮箱归一化为小写后比对（DTO 已 Transform，此处双保险）
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly rbac: RbacService,
  ) {}

  /** 登录：校验口令 → 更新 lastLoginAt → 签发 JWT */
  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const email = dto.email.trim().toLowerCase();
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });

    // 账号不存在时也执行一次同成本哈希比较，避免时间侧信道
    const passwordOk = admin
      ? await verifyPassword(dto.password, admin.passwordHash)
      : await verifyPassword(dto.password, DUMMY_HASH);

    if (!admin || !admin.isActive || !passwordOk) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const lastLoginAt = new Date();
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt },
      select: { id: true },
    });

    const payload: JwtPayload = { sub: admin.id, email: admin.email, role: admin.role };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: this.config.getOrThrow<string>('jwtExpiresIn') as unknown as JwtExpiresIn,
    });

    this.logger.log(`管理员登录成功: ${admin.email} (${admin.role})`);

    // Phase 4.6：登录响应即带出生效角色与权限，前端首屏即可正确渲染菜单
    const access = await this.rbac.resolveAccess(admin.id);

    return {
      accessToken,
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        roles: access.roleKeys,
        permissions: [...access.permissions].sort(),
        isSuperAdmin: access.isSuperAdmin,
        jobTitle: admin.jobTitle,
        isActive: admin.isActive,
        lastLoginAt,
      },
    };
  }

  /**
   * 当前登录管理员（GET /auth/me）。
   * 以数据库实时状态为准：账号被停用或删除后，既有令牌立即失效。
   *
   * Phase 4.6：同时返回生效角色与权限（停用角色立即从列表中消失）。
   */
  async me(auth: AuthUser): Promise<AdminProfileDto> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: auth.id } });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Account is no longer active');
    }
    const access = await this.rbac.resolveAccess(admin.id);
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      roles: access.roleKeys,
      permissions: [...access.permissions].sort(),
      isSuperAdmin: access.isSuperAdmin,
      jobTitle: admin.jobTitle,
      isActive: admin.isActive,
      lastLoginAt: admin.lastLoginAt,
    };
  }
}
