import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdminRole, RfqStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';

/**
 * 认证与 CMS 接口端到端测试。
 *
 * 依赖本地 Docker PostgreSQL（admin_users / rfqs 表已存在）。
 * 覆盖阶段要求的四项：login success / login failure / JWT protect / me endpoint，
 * 另加 CMS stats 的 JWT 保护与 RFQ 既有兼容性（不破坏 Phase 3.7）。
 */

const E2E_PASSWORD = 'E2E-pass-2026!';
const E2E_EMAIL = 'e2e-auth@bailingwooden.test';

describe('Auth + CMS（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let config: ConfigService;
  let adminId: string;
  let createdRfqId: string | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    config = app.get(ConfigService);
    expect(config.getOrThrow<string>('jwtSecret')).not.toBe('');

    // 准备一个专用测试管理员（低成本哈希，测试后清理）
    await prisma.adminUser.deleteMany({ where: { email: E2E_EMAIL } });
    const admin = await prisma.adminUser.create({
      data: {
        email: E2E_EMAIL,
        passwordHash: bcrypt.hashSync(E2E_PASSWORD, 4),
        name: 'E2E Auth Admin',
        role: AdminRole.ADMIN,
        isActive: true,
      },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    if (createdRfqId) await prisma.rfq.deleteMany({ where: { id: createdRfqId } });
    await app.close();
  });

  /* --------------------------- login --------------------------- */

  it('login success：正确凭证返回 accessToken 与用户摘要', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: E2E_EMAIL, password: E2E_PASSWORD })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.accessToken.length).toBeGreaterThan(20);
    expect(res.body.data.user).toMatchObject({
      id: adminId,
      email: E2E_EMAIL,
      role: AdminRole.ADMIN,
    });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');

    // lastLoginAt 已落库
    const fresh = await prisma.adminUser.findUnique({ where: { id: adminId } });
    expect(fresh?.lastLoginAt).not.toBeNull();
  });

  it('login failure：口令错误返回 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: E2E_EMAIL, password: 'definitely-wrong' })
      .expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(401);
  });

  it('login failure：邮箱不存在返回同一个 401（防账号枚举）', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@bailingwooden.test', password: E2E_PASSWORD })
      .expect(401);
  });

  it('login failure：缺字段 / 非法邮箱被 DTO 校验拦截（400）', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: E2E_EMAIL }).expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: E2E_PASSWORD })
      .expect(400);
  });

  /* ------------------------ JWT protect ----------------------- */

  it('JWT protect：无令牌访问 /auth/me 返回 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('JWT protect：伪造/篡改令牌返回 401', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer forged.token.value')
      .expect(401);
  });

  it('me endpoint：有效令牌返回当前管理员信息', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: E2E_EMAIL, password: E2E_PASSWORD })
      .expect(200);
    const token = login.body.data.accessToken as string;

    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.data).toMatchObject({ id: adminId, email: E2E_EMAIL, role: AdminRole.ADMIN });
    expect(res.body.data).not.toHaveProperty('passwordHash');
  });

  /* ------------------------- CMS stats ------------------------ */

  it('CMS stats：无令牌返回 401（新增 CMS 接口全部 JWT 保护）', async () => {
    await request(app.getHttpServer()).get('/api/v1/cms/stats').expect(401);
  });

  it('CMS stats：有效令牌返回真实统计（与数据库计数一致，无虚构数字）', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: E2E_EMAIL, password: E2E_PASSWORD })
      .expect(200);
    const token = login.body.data.accessToken as string;

    const [rfqTotal, rfqNew, productTotal] = await Promise.all([
      prisma.rfq.count(),
      prisma.rfq.count({ where: { status: RfqStatus.NEW } }),
      prisma.product.count(),
    ]);

    const res = await request(app.getHttpServer())
      .get('/api/v1/cms/stats')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.data.rfq.total).toBe(rfqTotal);
    expect(res.body.data.rfq.byStatus.NEW).toBe(rfqNew);
    expect(res.body.data.products.total).toBe(productTotal);
    expect(res.body.data.rfq.byStatus).toHaveProperty('CONTACTED');
  });

  /* ------------------- RFQ 兼容性（Phase 3.7） ------------------- */

  it('RFQ 兼容：公开提交 POST /rfq 仍返回 201（未引入登录门槛）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/rfq')
      .send({
        name: 'E2E Tester',
        company: 'Compatibility Ltd',
        email: 'e2e-compat@buyer.test',
        country: 'Germany',
        message: 'E2E compatibility probe message for RFQ public endpoint.',
      })
      .expect(201);
    createdRfqId = res.body.data.id as string;
  });

  it('RFQ 兼容：后台列表 GET /rfq 行为不变（未配置 ADMIN_API_TOKEN 时本地放行）', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/rfq?pageSize=1');
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('total');
    }
  });
});
