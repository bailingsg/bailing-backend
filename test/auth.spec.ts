import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { RbacService } from '../src/modules/rbac/rbac.service';
import { AuditLogService } from '../src/modules/rbac/audit-log.service';
import { RevalidationService } from '../src/modules/revalidation/revalidation.service';
import { STORAGE_PROVIDER } from '../src/modules/media/storage/storage.interface';
import { makeRevalidationMock } from './helpers/revalidation-mock';

/** 测试口令与低成本的测试哈希（避免测试被 bcrypt 成本拖慢） */
const TEST_PASSWORD = 'Test-pass-2026';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

/** 最小 PNG 头（8 字节签名 + 4 字节填充），足以通过魔数校验 */
const PNG_BUFFER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);

function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'avatar.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: PNG_BUFFER.length,
    buffer: PNG_BUFFER,
    ...overrides,
  } as Express.Multer.File;
}

function makeAdmin(overrides: Record<string, unknown> = {}) {
  return {
    id: 'admin_test_1',
    email: 'admin@bailingwooden.com',
    passwordHash: TEST_HASH,
    name: 'Administrator',
    role: AdminRole.ADMIN,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
    updatedAt: new Date('2026-10-14T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AuthService（单元）', () => {
  let service: AuthService;
  let prisma: {
    adminUser: { findUnique: jest.Mock; update: jest.Mock };
    employeeContact: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock };
  let rbac: { resolveAccess: jest.Mock };
  let storage: { upload: jest.Mock; delete: jest.Mock; getUrl: jest.Mock };

  /** 默认访问上下文：未分配角色的历史账号按旧枚举 ADMIN → SUPER_ADMIN 兼容 */
  function makeAccess(overrides: Record<string, unknown> = {}) {
    return {
      adminUserId: 'admin_test_1',
      email: 'admin@bailingwooden.com',
      name: 'Administrator',
      isActive: true,
      roleKeys: ['SUPER_ADMIN'],
      permissions: new Set<string>(['dashboard.read']),
      isSuperAdmin: true,
      isLegacyFallback: true,
      ...overrides,
    };
  }

  beforeEach(async () => {
    prisma = {
      adminUser: { findUnique: jest.fn(), update: jest.fn() },
      // 自助头像 / 档案里的 avatarUrl 会读 employee_contacts
      employeeContact: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn(), create: jest.fn() },
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };
    rbac = { resolveAccess: jest.fn().mockResolvedValue(makeAccess()) };
    storage = {
      upload: jest.fn().mockResolvedValue({
        storageKey: 'media/2026/10/new.png',
        filename: 'new.png',
        url: 'https://cdn.bailingwooden.com/media/2026/10/new.png',
      }),
      delete: jest.fn().mockResolvedValue(undefined),
      getUrl: jest.fn((key: string) => `https://cdn.bailingwooden.com/${key}`),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('15m') } },
        { provide: RbacService, useValue: rbac },
        // 登录会写审计日志（login 成功/失败均记录）；单测只关心令牌与摘要，注入替身
        { provide: AuditLogService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        // 资料变更（activate/deactivate/remove）会通知前台失效联系方式缓存
        { provide: RevalidationService, useValue: makeRevalidationMock() },
        // 自助头像上传依赖 StorageProvider（Local / COS 透明）
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('login', () => {
    it('邮箱 + 口令正确时返回 accessToken 与用户摘要，且不含 passwordHash', async () => {
      const admin = makeAdmin();
      prisma.adminUser.findUnique.mockResolvedValue(admin);
      prisma.adminUser.update.mockResolvedValue({ id: admin.id });

      const result = await service.login({ email: 'admin@bailingwooden.com', password: TEST_PASSWORD });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).toMatchObject({
        id: admin.id,
        email: admin.email,
        role: AdminRole.ADMIN,
      });
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(jwt.signAsync).toHaveBeenCalledWith(
        { sub: admin.id, email: admin.email, role: admin.role },
        { expiresIn: '15m' },
      );
      // lastLoginAt 已更新
      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: admin.id } }),
      );
    });

    it('邮箱大小写混杂时仍可登录（归一化为小写比对）', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin());
      prisma.adminUser.update.mockResolvedValue({ id: 'admin_test_1' });

      const result = await service.login({ email: 'Admin@BailingWooden.com', password: TEST_PASSWORD });
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(prisma.adminUser.findUnique).toHaveBeenCalledWith({
        where: { email: 'admin@bailingwooden.com' },
      });
    });

    it('口令错误时抛出 401 Invalid email or password（不区分账号是否存在）', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin());

      await expect(
        service.login({ email: 'admin@bailingwooden.com', password: 'wrong-password' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
      // 失败不得更新 lastLoginAt、不得签发令牌
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('邮箱不存在时同样抛出同一个 401（防止账号枚举）', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@bailingwooden.com', password: TEST_PASSWORD }),
      ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('账号被停用（isActive=false）时登录失败', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin({ isActive: false }));

      await expect(
        service.login({ email: 'admin@bailingwooden.com', password: TEST_PASSWORD }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('me', () => {
    it('账号有效时返回档案且不含 passwordHash', async () => {
      const admin = makeAdmin();
      prisma.adminUser.findUnique.mockResolvedValue(admin);

      const profile = await service.me({ id: admin.id, email: admin.email, role: admin.role });
      expect(profile).not.toHaveProperty('passwordHash');
      expect(profile.role).toBe(AdminRole.ADMIN);
      // 未上传头像时为 null（顶栏显示首字母占位）
      expect(profile.avatarUrl).toBeNull();
    });

    it('已上传头像时档案带出动态生成的地址', async () => {
      const admin = makeAdmin();
      prisma.adminUser.findUnique.mockResolvedValue(admin);
      prisma.employeeContact.findUnique.mockResolvedValue({
        avatarKey: 'media/2026/10/avatar.png',
        avatarUrl: 'https://stale.example.com/avatar.png',
      });

      const profile = await service.me({ id: admin.id, email: admin.email, role: admin.role });
      // 优先用 storageKey 现算，不用可能失效的快照
      expect(profile.avatarUrl).toBe('https://cdn.bailingwooden.com/media/2026/10/avatar.png');
    });

    it('账号被停用后既有令牌立即失效（401）', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin({ isActive: false }));

      await expect(
        service.me({ id: 'admin_test_1', email: 'admin@bailingwooden.com', role: AdminRole.ADMIN }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('账号被删除后令牌失效（401）', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);

      await expect(
        service.me({ id: 'admin_test_1', email: 'admin@bailingwooden.com', role: AdminRole.ADMIN }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('changePassword（自助修改口令）', () => {
    const auth = { id: 'admin_test_1', email: 'admin@bailingwooden.com', role: AdminRole.ADMIN };

    it('当前口令正确时写入新口令哈希（不落明文）', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin());
      prisma.adminUser.update.mockResolvedValue({ id: 'admin_test_1' });

      await expect(
        service.changePassword(auth, {
          currentPassword: TEST_PASSWORD,
          newPassword: 'Brand-new-pass-2026',
        }),
      ).resolves.toEqual({ changed: true });

      const call = prisma.adminUser.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'admin_test_1' });
      expect(call.data.passwordHash).not.toBe('Brand-new-pass-2026');
      await expect(bcrypt.compare('Brand-new-pass-2026', call.data.passwordHash)).resolves.toBe(true);
    });

    it('当前口令错误时抛 400 且不写库（不是 401，避免前端误判为登录失效）', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin());

      await expect(
        service.changePassword(auth, {
          currentPassword: 'wrong-password',
          newPassword: 'Brand-new-pass-2026',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it('新旧口令相同时拒绝', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin());

      await expect(
        service.changePassword(auth, {
          currentPassword: TEST_PASSWORD,
          newPassword: TEST_PASSWORD,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });
  });

  describe('setMyAvatar / removeMyAvatar（自助头像）', () => {
    const auth = { id: 'admin_test_1', email: 'admin@bailingwooden.com', role: AdminRole.ADMIN };

    it('替换头像：上传新对象后删除服务器上的旧对象', async () => {
      const admin = makeAdmin();
      prisma.adminUser.findUnique.mockResolvedValue(admin);
      prisma.employeeContact.findUnique
        // 1) setMyAvatar 里读取现有 contact
        .mockResolvedValueOnce({ id: 'contact_1', avatarKey: 'media/2026/10/old.png' })
        // 2) 末尾 myProfile 重新读取
        .mockResolvedValueOnce({
          displayName: 'Administrator',
          jobTitle: null,
          displayEmail: null,
          whatsapp: null,
          phone: null,
          avatarKey: 'media/2026/10/new.png',
          avatarUrl: 'https://cdn.bailingwooden.com/media/2026/10/new.png',
          showOnSite: false,
        });
      prisma.employeeContact.update.mockResolvedValue({ id: 'contact_1' });

      const result = await service.setMyAvatar(auth, makeFile());

      // 落库为新 key
      expect(prisma.employeeContact.update).toHaveBeenCalledWith({
        where: { id: 'contact_1' },
        data: {
          avatarKey: 'media/2026/10/new.png',
          avatarUrl: 'https://cdn.bailingwooden.com/media/2026/10/new.png',
        },
      });
      // 旧文件被删除（不留孤儿）
      expect(storage.delete).toHaveBeenCalledWith('media/2026/10/old.png');
      expect(result.contact?.avatarUrl).toBe(
        'https://cdn.bailingwooden.com/media/2026/10/new.png',
      );
    });

    it('首次上传：自动创建联系方式，且不调用删除（没有旧文件）', async () => {
      const admin = makeAdmin();
      prisma.adminUser.findUnique.mockResolvedValue(admin);
      prisma.employeeContact.findUnique
        .mockResolvedValueOnce(null) // 还没有 contact
        .mockResolvedValueOnce({
          displayName: 'Administrator',
          jobTitle: null,
          displayEmail: null,
          whatsapp: null,
          phone: null,
          avatarKey: 'media/2026/10/new.png',
          avatarUrl: 'https://cdn.bailingwooden.com/media/2026/10/new.png',
          showOnSite: false,
        });
      prisma.employeeContact.create.mockResolvedValue({ id: 'contact_new' });

      await service.setMyAvatar(auth, makeFile());

      expect(prisma.employeeContact.create).toHaveBeenCalledWith({
        data: {
          adminUserId: 'admin_test_1',
          displayName: 'Administrator',
          avatarKey: 'media/2026/10/new.png',
          avatarUrl: 'https://cdn.bailingwooden.com/media/2026/10/new.png',
        },
      });
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('非图片（如 PDF）被拒绝，且不落库、不上传', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin());

      await expect(
        service.setMyAvatar(
          auth,
          makeFile({ mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.7') }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(storage.upload).not.toHaveBeenCalled();
      expect(prisma.employeeContact.update).not.toHaveBeenCalled();
    });

    it('移除头像：清空字段并删除存储对象', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(makeAdmin());
      prisma.employeeContact.findUnique
        .mockResolvedValueOnce({ id: 'contact_1', avatarKey: 'media/2026/10/old.png' })
        .mockResolvedValueOnce(null); // myProfile：已无 contact 时的兜底分支
      prisma.employeeContact.update.mockResolvedValue({ id: 'contact_1' });

      await service.removeMyAvatar(auth);

      expect(prisma.employeeContact.update).toHaveBeenCalledWith({
        where: { id: 'contact_1' },
        data: { avatarKey: null, avatarUrl: null },
      });
      expect(storage.delete).toHaveBeenCalledWith('media/2026/10/old.png');
    });
  });
});
