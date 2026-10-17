import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';

/**
 * RFQ 后台接口鉴权端到端测试（Phase 0）。
 *
 * 覆盖任务书 4.3 要求的访问矩阵：
 *   · 未登录访问                    → 401
 *   · 错误共享令牌                  → 401
 *   · 正确共享令牌                  → 200
 *   · JWT 无效                      → 401
 *   · 已登录但无 rfq 权限            → 403
 *   · 具备 rfq.read                  → 200（列表 / 详情）
 *   · 只有 rfq.read 不能改状态       → 403（编辑权限不推导跟进权限）
 *   · 具备 rfq.update                → 200
 *
 * 「ADMIN_API_TOKEN 缺失 / 空串」导致 503 的用例在单测
 * （test/rfq-auth.spec.ts）中覆盖——e2e 需要固定一个令牌才能验证「正确令牌」分支。
 *
 * 依赖本地 Docker PostgreSQL；测试数据统一 e2e-rfq-auth- 前缀，前后清理。
 */

const ADMIN_TOKEN = 'e2e-rfq-admin-token-phase0';
const PASSWORD = 'E2E-rfq-2026!';

const SUPER_EMAIL = 'e2e-rfq-super@bailingwooden.test';
const READER_EMAIL = 'e2e-rfq-reader@bailingwooden.test';
const NOPERM_EMAIL = 'e2e-rfq-noperm@bailingwooden.test';

const RUN_ID = Date.now().toString(36);
const READER_ROLE_KEY = `E2E_RFQ_READER_${RUN_ID}`;
const NOPERM_ROLE_KEY = `E2E_RFQ_NOPERM_${RUN_ID}`;

describe('RFQ 后台鉴权（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let originalToken: string | undefined;

  let superToken: string;
  let readerToken: string;
  let noPermToken: string;
  let rfqId: string;

  const bearer = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    originalToken = process.env.ADMIN_API_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();

    // 权限清单由 seed 写入；测试库若未跑 seed，这里幂等补齐本次需要的两条
    for (const def of [
      { key: 'rfq.read', module: 'rfq', action: 'read', name: '查看询盘', isNav: true, sortOrder: 10 },
      { key: 'rfq.update', module: 'rfq', action: 'update', name: '跟进询盘状态', isNav: false, sortOrder: 20 },
    ]) {
      await prisma.permission.upsert({
        where: { key: def.key },
        update: {},
        create: def,
      });
    }

    const superRole = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
    const readPermission = await prisma.permission.findUniqueOrThrow({ where: { key: 'rfq.read' } });
    const productPermission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'products.read' },
    });

    const readerRole = await prisma.role.create({
      data: {
        key: READER_ROLE_KEY,
        name: 'E2E RFQ 只读',
        description: '仅有 rfq.read，用于验证「有编辑权限也不能发布/跟进」的边界',
        status: 'ACTIVE',
        isSystem: false,
        rolePermissions: { create: [{ permissionId: readPermission.id }] },
      },
    });

    const noPermRole = await prisma.role.create({
      data: {
        key: NOPERM_ROLE_KEY,
        name: 'E2E 无询盘权限',
        description: '仅有 products.read，用于验证 403',
        status: 'ACTIVE',
        isSystem: false,
        rolePermissions: { create: [{ permissionId: productPermission.id }] },
      },
    });

    await prisma.adminUser.create({
      data: {
        email: SUPER_EMAIL,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
        name: 'E2E RFQ Super',
        role: AdminRole.ADMIN,
        isActive: true,
        userRoles: { create: { roleId: superRole.id } },
      },
    });
    await prisma.adminUser.create({
      data: {
        email: READER_EMAIL,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
        name: 'E2E RFQ Reader',
        role: AdminRole.EDITOR,
        isActive: true,
        userRoles: { create: { roleId: readerRole.id } },
      },
    });
    await prisma.adminUser.create({
      data: {
        email: NOPERM_EMAIL,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
        name: 'E2E RFQ NoPerm',
        role: AdminRole.EDITOR,
        isActive: true,
        userRoles: { create: { roleId: noPermRole.id } },
      },
    });

    const login = async (email: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      return res.body.data.accessToken as string;
    };

    superToken = await login(SUPER_EMAIL);
    readerToken = await login(READER_EMAIL);
    noPermToken = await login(NOPERM_EMAIL);

    // 准备一条真实询盘（公开入口），供详情 / 状态更新用例使用
    const created = await request(app.getHttpServer())
      .post('/api/v1/rfq')
      .send({
        name: 'E2E RFQ Buyer',
        company: 'E2E Buyer Ltd',
        email: 'e2e-rfq-buyer@buyer.test',
        country: 'United States',
        message: 'E2E RFQ authorization probe message with enough length.',
      })
      .expect(201);
    rfqId = created.body.data.id as string;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    if (originalToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = originalToken;
  });

  async function cleanup(): Promise<void> {
    await prisma.adminUser.deleteMany({
      where: { email: { in: [SUPER_EMAIL, READER_EMAIL, NOPERM_EMAIL] } },
    });
    await prisma.role.deleteMany({ where: { key: { in: [READER_ROLE_KEY, NOPERM_ROLE_KEY] } } });
    await prisma.rfq.deleteMany({ where: { email: 'e2e-rfq-buyer@buyer.test' } });
  }

  /* ------------------------- 未授权访问 ------------------------- */

  it('未登录访问：401，且不返回任何询盘数据', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/rfq').expect(401);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('e2e-rfq-buyer@buyer.test');
  });

  it('错误共享令牌：401', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/rfq')
      .set('x-admin-token', 'definitely-wrong')
      .expect(401);
  });

  it('缺少令牌头（已配置令牌时）：401，不是放行', async () => {
    await request(app.getHttpServer()).get('/api/v1/rfq').expect(401);
  });

  it('JWT 无效：401', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/rfq')
      .set(bearer('invalid.jwt.token'))
      .expect(401);
  });

  /* ------------------------- 兼容通道 ------------------------- */

  it('正确共享令牌：200（服务间兼容通道）', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/rfq?pageSize=1')
      .set('x-admin-token', ADMIN_TOKEN)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('total');
  });

  /* ------------------------- RBAC 通道 ------------------------- */

  it('已登录但无 rfq 权限：403', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/rfq')
      .set(bearer(noPermToken))
      .expect(403);
  });

  it('具备 rfq.read：列表与详情均 200', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/rfq')
      .set(bearer(readerToken))
      .expect(200);
    expect(list.body.data.items.length).toBeGreaterThan(0);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/rfq/${rfqId}`)
      .set(bearer(readerToken))
      .expect(200);
    expect(detail.body.data.id).toBe(rfqId);
  });

  it('只有 rfq.read 不能更新状态：403', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/rfq/${rfqId}/status`)
      .set(bearer(readerToken))
      .send({ status: 'CONTACTED' })
      .expect(403);
  });

  it('具备 rfq.update（超管）：状态更新 200', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/rfq/${rfqId}/status`)
      .set(bearer(superToken))
      .send({ status: 'CONTACTED' })
      .expect(200);
    expect(res.body.data.status).toBe('CONTACTED');
  });

  it('状态更新后仍可读回（回归：分配与状态流程未被鉴权改造破坏）', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/rfq/${rfqId}`)
      .set(bearer(superToken))
      .expect(200);
    expect(res.body.data.status).toBe('CONTACTED');
    expect(res.body.data.email).toBe('e2e-rfq-buyer@buyer.test');
  });
});
