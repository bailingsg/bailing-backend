import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { RfqAuthGuard } from '../src/modules/rfq/rfq-auth.guard';
import type { RbacService } from '../src/modules/rbac/rbac.service';

/**
 * RfqAuthGuard 单元测试（Phase 0 安全止血）。
 *
 * 核心不变量：**任何一条通道都不允许 fail-open**。
 *   · ADMIN_API_TOKEN 缺失 / 空串 / 纯空白 → 503（拒绝），而不是放行
 *   · 令牌错误 / 缺失 → 401
 *   · JWT 无效 / 账号停用 → 401
 *   · JWT 有效但缺少声明权限 → 403
 *   · 合法凭证 → 放行
 */

interface AccessOverrides {
  isActive?: boolean;
  permissions?: string[];
  isSuperAdmin?: boolean;
  email?: string;
}

/** 构造一个最小可用的 RbacService 桩 */
function makeRbac(overrides: AccessOverrides = {}): RbacService {
  const permissions = new Set(overrides.permissions ?? []);
  const isSuperAdmin = overrides.isSuperAdmin ?? false;
  if (isSuperAdmin) {
    // 超管在真实实现中恒等于权限全集；这里只需保证 satisfies 通过
    ['rfq.read', 'rfq.update'].forEach((p) => permissions.add(p));
  }
  const access = {
    adminUserId: 'admin-1',
    email: overrides.email ?? 'admin@bailing.test',
    name: null,
    isActive: overrides.isActive ?? true,
    roleKeys: [],
    roleNames: [],
    permissions,
    isSuperAdmin,
    isLegacyFallback: false,
  };
  return {
    resolveAccess: jest.fn().mockResolvedValue(access),
    satisfies: (ctx: typeof access, required: string[], mode: 'all' | 'any') => {
      if (!ctx.isActive) return false;
      if (required.length === 0) return true;
      return mode === 'all'
        ? required.every((p) => ctx.permissions.has(p))
        : required.some((p) => ctx.permissions.has(p));
    },
  } as unknown as RbacService;
}

function makeContext(options: {
  authorization?: string;
  adminToken?: string;
  required?: string[];
}): { context: ExecutionContext; request: Record<string, unknown> } {
  const headers: Record<string, unknown> = {};
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  if (options.adminToken !== undefined) headers['x-admin-token'] = options.adminToken;

  const request: Record<string, unknown> = { headers, method: 'GET', originalUrl: '/api/v1/rfq' };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return { context, request };
}

function makeGuard(config: {
  adminApiToken?: string;
  jwtPayload?: Record<string, unknown> | Error;
  rbac?: RbacService;
  required?: string[];
}): { guard: RfqAuthGuard; reflector: Reflector } {
  const reflector = {
    getAllAndOverride: jest.fn(() =>
      config.required ? { permissions: config.required, mode: 'all' } : undefined,
    ),
  } as unknown as Reflector;

  const jwt = {
    verifyAsync: jest.fn(async () => {
      if (config.jwtPayload instanceof Error) throw config.jwtPayload;
      return config.jwtPayload ?? { sub: 'admin-1', email: 'admin@bailing.test', role: 'ADMIN' };
    }),
  } as unknown as JwtService;

  const configService = {
    get: (key: string) => (key === 'adminApiToken' ? config.adminApiToken : undefined),
  } as unknown as ConfigService;

  return {
    guard: new RfqAuthGuard(reflector, jwt, config.rbac ?? makeRbac(), configService),
    reflector,
  };
}

describe('RfqAuthGuard（Phase 0）', () => {
  describe('兼容令牌通道（X-Admin-Token）', () => {
    it('ADMIN_API_TOKEN 缺失时 fail-closed：503 且不放行', async () => {
      const { guard } = makeGuard({ adminApiToken: undefined });
      const { context } = makeContext({});

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('ADMIN_API_TOKEN 为空串时 fail-closed：503', async () => {
      const { guard } = makeGuard({ adminApiToken: '' });
      const { context } = makeContext({ adminToken: '' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('ADMIN_API_TOKEN 为纯空白时 fail-closed：503', async () => {
      const { guard } = makeGuard({ adminApiToken: '   ' });
      const { context } = makeContext({ adminToken: '   ' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('令牌错误：401', async () => {
      const { guard } = makeGuard({ adminApiToken: 'correct-token' });
      const { context } = makeContext({ adminToken: 'wrong-token' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('未携带令牌：401（不是放行）', async () => {
      const { guard } = makeGuard({ adminApiToken: 'correct-token' });
      const { context } = makeContext({});

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('令牌正确：放行', async () => {
      const { guard } = makeGuard({ adminApiToken: 'correct-token' });
      const { context } = makeContext({ adminToken: 'correct-token' });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('JWT + RBAC 通道', () => {
    it('令牌无效：401', async () => {
      const { guard } = makeGuard({
        adminApiToken: '',
        jwtPayload: new Error('jwt expired'),
      });
      const { context } = makeContext({ authorization: 'Bearer invalid.jwt.token' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('账号已停用：401（不依赖令牌自然过期）', async () => {
      const { guard } = makeGuard({
        adminApiToken: '',
        rbac: makeRbac({ isActive: false, permissions: ['rfq.read'] }),
      });
      const { context } = makeContext({ authorization: 'Bearer valid.jwt.token' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('具备 rfq.read 权限：放行并挂载 request.user', async () => {
      const { guard } = makeGuard({
        adminApiToken: '',
        rbac: makeRbac({ permissions: ['rfq.read'] }),
        required: ['rfq.read'],
      });
      const { context, request } = makeContext({ authorization: 'Bearer valid.jwt.token' });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toMatchObject({ id: 'admin-1', email: 'admin@bailing.test' });
    });

    it('已登录但缺少权限：403（编辑权限不推导发布/跟进权限）', async () => {
      const { guard } = makeGuard({
        adminApiToken: '',
        rbac: makeRbac({ permissions: ['products.update'] }),
        required: ['rfq.update'],
      });
      const { context } = makeContext({ authorization: 'Bearer valid.jwt.token' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('超管：放行', async () => {
      const { guard } = makeGuard({
        adminApiToken: '',
        rbac: makeRbac({ isSuperAdmin: true }),
        required: ['rfq.read'],
      });
      const { context } = makeContext({ authorization: 'Bearer valid.jwt.token' });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });
});
