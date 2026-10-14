import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';

/** 测试口令与低成本的测试哈希（避免测试被 bcrypt 成本拖慢） */
const TEST_PASSWORD = 'Test-pass-2026';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

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
  };
  let jwt: { signAsync: jest.Mock };

  beforeEach(async () => {
    prisma = {
      adminUser: { findUnique: jest.fn(), update: jest.fn() },
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('15m') } },
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
});
