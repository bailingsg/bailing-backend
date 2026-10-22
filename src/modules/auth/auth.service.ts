import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { AdminUser } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { AuditLogService } from '../rbac/audit-log.service';
import { RevalidationService } from '../revalidation/revalidation.service';
import { CmsTags } from '../revalidation/cms-tags';
import type { AuthUser, JwtExpiresIn, JwtPayload } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { UpdateMyProfileDto } from './dto/update-profile.dto';
import type { AdminProfileDto, LoginResponseDto, MyContactDto, MyProfileDto } from './auth.dto';

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
    private readonly audit: AuditLogService,
    private readonly revalidation: RevalidationService,
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
    const admin = await this.requireActiveAdmin(auth.id);
    return this.buildProfile(admin);
  }

  /**
   * 我的资料（GET /auth/profile）：账号档案 + 自己的联系方式。
   *
   * 与 /auth/me 的差别：额外带出自己的 EmployeeContact 展示字段，
   * 供「账号设置」页面回填；**不含** internalNote / isLeadContact / sortOrder。
   */
  async myProfile(auth: AuthUser): Promise<MyProfileDto> {
    const admin = await this.requireActiveAdmin(auth.id);
    const [profile, contact] = await Promise.all([
      this.buildProfile(admin),
      this.prisma.employeeContact.findUnique({ where: { adminUserId: admin.id } }),
    ]);
    return { profile, contact: contact ? toMyContact(contact) : null };
  }

  /**
   * 自助修改「我的账号」资料（PATCH /auth/profile）。
   *
   * 设计要点：
   *   · **不走 contacts.update 权限**：员工维护自己的资料属于自助行为，
   *     SALES 等角色只有 contacts.read，不该被迫找管理员改资料
   *   · 只能改自己（adminUserId 恒为 JWT 里的 sub，请求体无法指定他人）
   *   · 登录邮箱改动需全站唯一；JWT 内的 email 声明会陈旧，
   *     但 /auth/me 以数据库为准，故界面立即正确（下次登录用新邮箱）
   *   · 首次保存展示信息时自动创建 EmployeeContact（displayName 必填）
   *   · 展示字段变更后通知前台失效（/contact 为 no-store，此处是双保险）
   */
  async updateMyProfile(auth: AuthUser, dto: UpdateMyProfileDto): Promise<MyProfileDto> {
    const admin = await this.requireActiveAdmin(auth.id);

    const accountData: { name?: string; jobTitle?: string | null; email?: string } = {};
    if (dto.name !== undefined) accountData.name = dto.name.trim();
    if (dto.jobTitle !== undefined) accountData.jobTitle = dto.jobTitle.trim() || null;
    if (dto.email !== undefined) {
      const nextEmail = dto.email.trim().toLowerCase();
      if (nextEmail === '') {
        throw new BadRequestException('登录邮箱不能为空');
      }
      if (nextEmail !== admin.email) {
        const taken = await this.prisma.adminUser.findUnique({
          where: { email: nextEmail },
          select: { id: true },
        });
        if (taken && taken.id !== admin.id) {
          throw new ConflictException('该邮箱已被其他账号使用，请换一个');
        }
        accountData.email = nextEmail;
      }
    }

    const existing = await this.prisma.employeeContact.findUnique({
      where: { adminUserId: admin.id },
    });

    // 只有「展示类字段」出现时才动 EmployeeContact
    const touchesContact =
      dto.displayName !== undefined ||
      dto.displayJobTitle !== undefined ||
      dto.displayEmail !== undefined ||
      dto.whatsapp !== undefined ||
      dto.phone !== undefined ||
      dto.showOnSite !== undefined;

    const contactData = touchesContact
      ? this.buildContactData(admin, existing, dto)
      : null;

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(accountData).length > 0) {
        await tx.adminUser.update({ where: { id: admin.id }, data: accountData });
      }
      if (contactData) {
        if (existing) {
          await tx.employeeContact.update({ where: { id: existing.id }, data: contactData });
        } else {
          await tx.employeeContact.create({
            data: { ...contactData, adminUserId: admin.id },
          });
        }
      }
    });

    await this.audit.record({
      actor: { id: admin.id, email: admin.email },
      action: 'auth.profile.update',
      targetType: 'AdminUser',
      targetId: admin.id,
      summary: `自助更新个人资料${contactData ? '（含官网展示信息）' : ''}`,
      // 口令/哈希从不在此链路出现；邮箱变更保留前后值便于追溯
      diff: {
        before: { email: admin.email, name: admin.name, jobTitle: admin.jobTitle },
        after: {
          email: accountData.email ?? admin.email,
          name: accountData.name ?? admin.name,
          jobTitle: accountData.jobTitle === undefined ? admin.jobTitle : accountData.jobTitle,
        },
        contactChanged: Boolean(contactData),
      },
    });

    this.logger.log(`个人资料自助更新: ${accountData.email ?? admin.email}`);

    if (contactData) {
      void this.revalidation.invalidate({ tags: [CmsTags.contacts], paths: ['/contact'] });
    }

    return this.myProfile({ ...auth, email: accountData.email ?? admin.email });
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 取当前账号（数据库实时状态）；停用/删除即 401 */
  private async requireActiveAdmin(id: string): Promise<AdminUser> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Account is no longer active');
    }
    return admin;
  }

  /** AdminUser → 对外档案（含生效角色与权限） */
  private async buildProfile(admin: AdminUser): Promise<AdminProfileDto> {
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

  /**
   * 组装 EmployeeContact 的写入数据。
   *
   * 字段语义：**不传 = 保留原值**；传空串 = 清空（仅展示类可选字段）。
   * displayName 为必填：新建时取「入参 → 已有值 → 账号姓名 → 邮箱前缀」，
   * 仍然不足 2 字符则拒绝（数据库层无长度约束，这里兜住脏数据）。
   */
  private buildContactData(
    admin: AdminUser,
    existing: {
      displayName: string;
      jobTitle: string | null;
      displayEmail: string | null;
      whatsapp: string | null;
      phone: string | null;
      showOnSite: boolean;
    } | null,
    dto: UpdateMyProfileDto,
  ): {
    displayName: string;
    jobTitle: string | null;
    displayEmail: string | null;
    whatsapp: string | null;
    phone: string | null;
    showOnSite: boolean;
  } {
    const rawDisplayName =
      dto.displayName ??
      existing?.displayName ??
      admin.name ??
      admin.email.split('@')[0] ??
      '';
    const displayName = rawDisplayName.trim();
    if (displayName.length < 2 || displayName.length > 50) {
      throw new BadRequestException('请填写对外展示姓名（2–50 个字符）');
    }

    const pick = (next: string | undefined, prev: string | null): string | null => {
      if (next === undefined) return prev;
      const trimmed = next.trim();
      return trimmed === '' ? null : trimmed;
    };

    return {
      displayName,
      jobTitle: pick(dto.displayJobTitle, existing?.jobTitle ?? null),
      displayEmail: pick(dto.displayEmail, existing?.displayEmail ?? null)?.toLowerCase() ?? null,
      whatsapp: pick(dto.whatsapp, existing?.whatsapp ?? null),
      phone: pick(dto.phone, existing?.phone ?? null),
      showOnSite: dto.showOnSite ?? existing?.showOnSite ?? false,
    };
  }
}

/** EmployeeContact → 自助视图（不含内部备注 / 分配相关字段） */
function toMyContact(contact: {
  displayName: string;
  jobTitle: string | null;
  displayEmail: string | null;
  whatsapp: string | null;
  phone: string | null;
  showOnSite: boolean;
}): MyContactDto {
  return {
    displayName: contact.displayName,
    jobTitle: contact.jobTitle,
    displayEmail: contact.displayEmail,
    whatsapp: contact.whatsapp,
    phone: contact.phone,
    showOnSite: contact.showOnSite,
  };
}
