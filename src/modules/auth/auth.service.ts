import {
  BadRequestException,
  ConflictException,
  Inject,
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
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../media/storage/storage.interface';
import {
  ALLOWED_IMAGE_MIME,
  validateUpload,
  verifyImageSignature,
} from '../media/media-file.util';
import type { AuthUser, JwtExpiresIn, JwtPayload } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { UpdateMyProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
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
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
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

    // Phase 4.6：登录响应即带出生效角色、权限与头像地址，前端首屏即可正确渲染菜单与顶栏。
    // lastLoginAt 用本次登录时间（数据库里刚写入的值），不要回显更新前的旧值。
    const user = await this.buildProfile({ ...admin, lastLoginAt });

    return { accessToken, user };
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
    const contact = await this.prisma.employeeContact.findUnique({
      where: { adminUserId: admin.id },
    });
    // 传入已查到的 contact，buildProfile 不再重复查同一行
    const profile = await this.buildProfile(admin, contact);
    return { profile, contact: contact ? this.toMyContact(contact) : null };
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

  /**
   * 自助上传 / 替换我的头像（PUT /auth/profile/avatar）。
   *
   * 与 CMS 侧 ContactsService.setAvatar 同一套语义：
   *   1. 先校验格式（MIME 白名单 + 大小 + 魔数，防伪造扩展名）
   *   2. 先把新对象传到 StorageProvider
   *   3. 再落库新 key/url
   *   4. **最后删除服务器上的旧对象**（替换头像必须清掉原文件，不留孤儿）
   *
   * 顺序不能反：若先删旧再传新，一旦上传失败员工连旧头像都没有；
   * 「先传后删」既保证失败无损，又保证成功后旧文件一定被清掉。
   *
   * 尚未绑定联系方式时自动创建一条（displayName 取账号姓名/邮箱前缀），
   * 否则员工会被「先去员工联系方式页建记录」这种不合理前置挡住。
   */
  async setMyAvatar(auth: AuthUser, file: Express.Multer.File): Promise<MyProfileDto> {
    const admin = await this.requireActiveAdmin(auth.id);

    const mime = file.mimetype ?? '';
    if (!Object.hasOwn(ALLOWED_IMAGE_MIME, mime)) {
      throw new BadRequestException(
        `不支持的头像格式: ${mime || 'unknown'}（仅支持 JPEG / PNG / WebP / AVIF）`,
      );
    }
    validateUpload(file);
    if (!verifyImageSignature(file.buffer, file.mimetype)) {
      throw new BadRequestException(
        '文件内容与声明格式不符（头像仅支持 jpeg / png / webp / avif，须通过魔数校验）',
      );
    }

    const existing = await this.prisma.employeeContact.findUnique({
      where: { adminUserId: admin.id },
      select: { id: true, avatarKey: true },
    });

    const stored = await this.storage.upload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });

    const staleKey = existing?.avatarKey ?? null;
    // 极端情况下新旧 key 相同（同一次上传返回同一对象）时不能删，否则刚传的就被删了
    const shouldDeleteStale = Boolean(staleKey) && staleKey !== stored.storageKey;

    if (existing) {
      await this.prisma.employeeContact.update({
        where: { id: existing.id },
        data: { avatarKey: stored.storageKey, avatarUrl: stored.url },
      });
    } else {
      await this.prisma.employeeContact.create({
        data: {
          adminUserId: admin.id,
          displayName: this.fallbackDisplayName(admin),
          avatarKey: stored.storageKey,
          avatarUrl: stored.url,
        },
      });
    }

    if (shouldDeleteStale) {
      await this.storage.delete(staleKey as string);
    }

    await this.audit.record({
      actor: { id: admin.id, email: admin.email },
      action: 'auth.avatar.update',
      targetType: 'AdminUser',
      targetId: admin.id,
      summary: `自助${shouldDeleteStale ? '替换' : '上传'}头像（删除旧对象：${shouldDeleteStale ? '是' : '否'}）`,
      diff: { before: { avatarKey: staleKey }, after: { avatarKey: stored.storageKey } },
    });

    this.logger.log(`自助头像已${shouldDeleteStale ? '替换' : '上传'}: ${admin.email}`);
    void this.revalidation.invalidate({ tags: [CmsTags.contacts], paths: ['/contact'] });

    return this.myProfile({ ...auth, email: admin.email });
  }

  /**
   * 移除我的头像（DELETE /auth/profile/avatar）。
   * 清空字段 + **删除存储对象**，不留孤儿文件；本就没有头像时幂等返回。
   */
  async removeMyAvatar(auth: AuthUser): Promise<MyProfileDto> {
    const admin = await this.requireActiveAdmin(auth.id);
    const existing = await this.prisma.employeeContact.findUnique({
      where: { adminUserId: admin.id },
      select: { id: true, avatarKey: true },
    });

    if (!existing?.avatarKey) {
      return this.myProfile({ ...auth, email: admin.email });
    }

    await this.prisma.employeeContact.update({
      where: { id: existing.id },
      data: { avatarKey: null, avatarUrl: null },
    });
    await this.storage.delete(existing.avatarKey);

    await this.audit.record({
      actor: { id: admin.id, email: admin.email },
      action: 'auth.avatar.remove',
      targetType: 'AdminUser',
      targetId: admin.id,
      summary: '自助移除头像（存储对象已删除）',
      diff: { before: { avatarKey: existing.avatarKey }, after: { avatarKey: null } },
    });

    this.logger.log(`自助头像已移除: ${admin.email}`);
    void this.revalidation.invalidate({ tags: [CmsTags.contacts], paths: ['/contact'] });

    return this.myProfile({ ...auth, email: admin.email });
  }

  /**
   * 自助修改口令（POST /auth/change-password）。
   *
   * 安全约定：
   *   · 必须校验当前口令——防止别人借用未锁屏的会话直接改密码
   *   · 当前口令错误返回 **400 而非 401**：401 会被前端当成「登录失效」跳登录页，
   *     而这里只是输错口令，用户应留在原页重试
   *   · 新旧口令相同直接拒绝（无意义，且易让人误以为已改成功）
   *   · 只写 passwordHash；审计只记「发生了修改」，绝不记录口令本身
   *
   * 关于旧会话：JWT 无状态（默认 15 分钟），改口令不会立即吊销已签发的令牌，
   * 该窗口由 JWT_EXPIRES_IN 兜底；界面会提示其他设备最迟 15 分钟后需重新登录。
   */
  async changePassword(auth: AuthUser, dto: ChangePasswordDto): Promise<{ changed: true }> {
    const admin = await this.requireActiveAdmin(auth.id);

    const currentOk = await verifyPassword(dto.currentPassword, admin.passwordHash);
    if (!currentOk) {
      throw new BadRequestException('当前口令不正确');
    }
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('新口令不能与当前口令相同');
    }

    const passwordHash = await hashPassword(dto.newPassword);
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } });

    await this.audit.record({
      actor: { id: admin.id, email: admin.email },
      action: 'auth.password.change',
      targetType: 'AdminUser',
      targetId: admin.id,
      summary: '自助修改登录口令',
      diff: { changed: 'passwordHash' },
    });

    this.logger.log(`口令自助修改: ${admin.email}`);
    return { changed: true };
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 头像上传时若还没有联系方式，用账号姓名/邮箱前缀兜底展示名（不足 2 字符则要求先填姓名） */
  private fallbackDisplayName(admin: AdminUser): string {
    const candidate = (admin.name ?? '').trim() || (admin.email.split('@')[0] ?? '').trim();
    if (candidate.length < 2) {
      throw new BadRequestException('请先在「账号信息」填写姓名（至少 2 个字符），再上传头像');
    }
    return candidate.slice(0, 50);
  }

  /**
   * 头像地址：**优先由 avatarKey 经当前 StorageProvider 动态生成**，取不到才回退快照。
   * 与 ContactsService 同一口径——快照地址在换存储/换 CDN 域名后会失效。
   */
  private resolveAvatarUrl(avatarKey: string | null, snapshot: string | null): string | null {
    if (avatarKey) {
      try {
        return this.storage.getUrl(avatarKey);
      } catch {
        this.logger.warn(`头像 storageKey 非法，回退快照地址：${avatarKey}`);
      }
    }
    return snapshot;
  }

  /** EmployeeContact → 自助视图（不含内部备注 / 分配相关字段） */
  private toMyContact(contact: {
    displayName: string;
    jobTitle: string | null;
    displayEmail: string | null;
    whatsapp: string | null;
    phone: string | null;
    avatarKey: string | null;
    avatarUrl: string | null;
    showOnSite: boolean;
  }): MyContactDto {
    return {
      displayName: contact.displayName,
      jobTitle: contact.jobTitle,
      displayEmail: contact.displayEmail,
      whatsapp: contact.whatsapp,
      phone: contact.phone,
      avatarUrl: this.resolveAvatarUrl(contact.avatarKey, contact.avatarUrl),
      showOnSite: contact.showOnSite,
    };
  }

  /** 取当前账号（数据库实时状态）；停用/删除即 401 */
  private async requireActiveAdmin(id: string): Promise<AdminUser> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Account is no longer active');
    }
    return admin;
  }

  /** AdminUser → 对外档案（含生效角色与权限、头像地址） */
  private async buildProfile(
    admin: AdminUser,
    /** 调用方已查过联系方式时传入，避免同一行查两遍；undefined 表示由本方法自己查 */
    contact?: { avatarKey: string | null; avatarUrl: string | null } | null,
  ): Promise<AdminProfileDto> {
    const [access, avatar] = await Promise.all([
      this.rbac.resolveAccess(admin.id),
      contact !== undefined
        ? Promise.resolve(contact)
        : this.prisma.employeeContact.findUnique({
            where: { adminUserId: admin.id },
            select: { avatarKey: true, avatarUrl: true },
          }),
    ]);
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      roles: access.roleKeys,
      permissions: [...access.permissions].sort(),
      isSuperAdmin: access.isSuperAdmin,
      jobTitle: admin.jobTitle,
      avatarUrl: this.resolveAvatarUrl(avatar?.avatarKey ?? null, avatar?.avatarUrl ?? null),
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
