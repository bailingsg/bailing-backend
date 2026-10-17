import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';

/**
 * 样品管理 e2e（Phase 5.1）。
 *
 * 覆盖：权限隔离（管理员/持有人/被授权人/无关业务员）、
 * 出库申请流程（发起 → 撤回 → 拒绝 → 重新申请 → 同意归档）、
 * 防重复申请（数据库部分唯一索引）、防自批、防重复审批、并发申请。
 */

const PREFIX = 'e2e-samples';
const RUN_ID = Date.now().toString(36);

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe('Samples CMS（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: TestUser;
  let sales1: TestUser; // 持有人
  let sales2: TestUser; // 被授权人
  let sales3: TestUser; // 无关业务员
  let sampleId: string;
  let requestId: string;

  async function makeUser(name: string, role: AdminRole): Promise<TestUser> {
    const email = `${PREFIX}-${name}-${RUN_ID}@bailingwooden.test`;
    await prisma.adminUser.deleteMany({ where: { email } });
    const user = await prisma.adminUser.create({
      data: {
        email,
        passwordHash: bcrypt.hashSync('E2E-pass-2026!', 4),
        name: `E2E ${name}`,
        role,
        isActive: true,
      },
    });
    // 绑定角色：SUPER_ADMIN（ADMIN）或 SALES
    const roleKey = role === AdminRole.ADMIN ? 'SUPER_ADMIN' : 'SALES';
    const roleRow = await prisma.role.upsert({
      where: { key: roleKey },
      update: {},
      create: { key: roleKey, name: roleKey, isSystem: true },
    });
    await prisma.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId: user.id, roleId: roleRow.id } },
      update: {},
      create: { adminUserId: user.id, roleId: roleRow.id },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'E2E-pass-2026!' })
      .expect(200);
    return { id: user.id, email, token: login.body.data.accessToken };
  }

  const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // 清理历史残留
    const stale = await prisma.adminUser.findMany({
      where: { email: { contains: `${PREFIX}-` } },
      select: { id: true },
    });
    for (const u of stale) {
      await prisma.sampleRequest.deleteMany({ where: { OR: [{ requesterId: u.id }, { ownerId: u.id }] } });
      await prisma.sampleGrant.deleteMany({ where: { OR: [{ granteeId: u.id }, { grantedById: u.id }] } });
      await prisma.sample.deleteMany({ where: { ownerId: u.id } });
      await prisma.adminUser.deleteMany({ where: { id: u.id } });
    }

    admin = await makeUser('admin', AdminRole.ADMIN);
    sales1 = await makeUser('sales1', AdminRole.EDITOR);
    sales2 = await makeUser('sales2', AdminRole.EDITOR);
    sales3 = await makeUser('sales3', AdminRole.EDITOR);
  }, 60_000);

  afterAll(async () => {
    const users = [admin, sales1, sales2, sales3];
    for (const u of users) {
      await prisma.sampleRequest.deleteMany({ where: { OR: [{ requesterId: u.id }, { ownerId: u.id }] } });
      await prisma.sampleGrant.deleteMany({ where: { OR: [{ granteeId: u.id }, { grantedById: u.id }] } });
      await prisma.sample.deleteMany({ where: { ownerId: u.id } });
    }
    await prisma.adminUser.deleteMany({
      where: { email: { contains: `${PREFIX}-` } },
    });
    await app.close();
  });

  it('业务员创建样品：持有人自动关联本人，状态为库中，编号自动生成', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/samples')
      .set(auth(sales1))
      .send({
        name: `胡桃木样品-${RUN_ID}`,
        spec: '1220x2440x18mm',
        material: '胡桃木',
        usage: '家具面板',
        quantity: 3,
        unit: '片',
        location: 'A区-3号货架-2层',
      })
      .expect(201);
    sampleId = res.body.data.id;
    expect(res.body.data.ownerId).toBe(sales1.id);
    expect(res.body.data.status).toBe('IN_STOCK');
    expect(res.body.data.code).toMatch(/^SP-\d{8}-[A-F0-9]{6}$/);
  });

  it('数量为负数 / 0 / 非整数被拒绝', async () => {
    for (const quantity of [0, -1, 1.5]) {
      await request(app.getHttpServer())
        .post('/api/v1/cms/samples')
        .set(auth(sales1))
        .send({ name: 'x', quantity, unit: '片', location: 'A' })
        .expect(400);
    }
  });

  it('管理员可以查看全部样品；无关业务员看不到他人样品', async () => {
    const adminList = await request(app.getHttpServer())
      .get('/api/v1/cms/samples')
      .set(auth(admin))
      .expect(200);
    expect(adminList.body.data.items.some((s: { id: string }) => s.id === sampleId)).toBe(true);

    const s3List = await request(app.getHttpServer())
      .get('/api/v1/cms/samples')
      .set(auth(sales3))
      .expect(200);
    expect(s3List.body.data.items.some((s: { id: string }) => s.id === sampleId)).toBe(false);
  });

  it('未授权业务员访问详情 → 404（不泄漏存在性）', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales3))
      .expect(404);
  });

  it('业务员不能编辑他人样品、不能授权、不能查看归档历史', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales3))
      .send({ name: '改名字' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sampleId}/grants`)
      .set(auth(sales2))
      .send({ userIds: [sales3.id] })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/cms/samples/archive')
      .set(auth(sales2))
      .expect(403);
  });

  it('管理员授权后，被授权业务员可以查看样品详情；撤销后不能', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sampleId}/grants`)
      .set(auth(admin))
      .send({ userIds: [sales2.id] })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales2))
      .expect(200);
    expect(detail.body.data.grants.some((g: { granteeId: string }) => g.granteeId === sales2.id)).toBe(true);

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/samples/${sampleId}/grants/${sales2.id}`)
      .set(auth(admin))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales2))
      .expect(404);

    // 重新授权，供后续流程使用
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sampleId}/grants`)
      .set(auth(admin))
      .send({ userIds: [sales2.id] })
      .expect(201);
  });

  it('被授权业务员发起出库申请 → 状态变为申请出库；重复申请 409', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sampleId}/requests`)
      .set(auth(sales2))
      .send({ purpose: `客户看样-${RUN_ID}` })
      .expect(201);
    requestId = res.body.data.id;

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales1))
      .expect(200);
    expect(detail.body.data.status).toBe('REQUEST_OUT');
    expect(detail.body.data.pendingRequest).not.toBeNull();

    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sampleId}/requests`)
      .set(auth(sales1))
      .send({ purpose: '重复申请' })
      .expect(409);
  });

  it('非申请人不能撤回；申请人撤回后样品恢复库中', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/withdraw`)
      .set(auth(sales1))
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/withdraw`)
      .set(auth(sales2))
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales1))
      .expect(200);
    expect(detail.body.data.status).toBe('IN_STOCK');

    // 已撤回的申请不能重复处理
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/decide`)
      .set(auth(sales1))
      .send({ decision: 'APPROVE' })
      .expect(409);
  });

  it('拒绝流程：状态变已拒绝；被拒后可重新申请', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sampleId}/requests`)
      .set(auth(sales2))
      .send({ purpose: '第二次申请' })
      .expect(201);
    requestId = res.body.data.id;

    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/decide`)
      .set(auth(sales1))
      .send({ decision: 'REJECT' })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales1))
      .expect(200);
    expect(detail.body.data.status).toBe('REJECTED');

    const again = await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sampleId}/requests`)
      .set(auth(sales2))
      .send({ purpose: '被拒后重新申请' })
      .expect(201);
    requestId = again.body.data.id;
  });

  it('防自批：申请人（即使不是持有人场景外的管理员）不能审批自己的申请；非持有人不能审批', async () => {
    // 申请人 sales2 不是持有人 → sales2 尝试审批 → 403（非持有人）
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/decide`)
      .set(auth(sales2))
      .send({ decision: 'APPROVE' })
      .expect(403);
    // 无关业务员 → 403
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/decide`)
      .set(auth(sales3))
      .send({ decision: 'APPROVE' })
      .expect(403);
    // 管理员（非持有人）也不能代批
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/decide`)
      .set(auth(admin))
      .send({ decision: 'APPROVE' })
      .expect(403);
  });

  it('并发申请：同一样品同时只允许一个有效申请', async () => {
    // 撤回当前申请腾出名额
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/withdraw`)
      .set(auth(sales2))
      .expect(201);

    // 持有人与被授权人同时发起
    const [r1, r2] = await Promise.allSettled([
      request(app.getHttpServer())
        .post(`/api/v1/cms/samples/${sampleId}/requests`)
        .set(auth(sales1))
        .send({ purpose: '并发A' }),
      request(app.getHttpServer())
        .post(`/api/v1/cms/samples/${sampleId}/requests`)
        .set(auth(sales2))
        .send({ purpose: '并发B' }),
    ]);
    const bodies = [r1, r2].map((r) => (r as PromiseFulfilledResult<request.Response>).value);
    const codes = bodies
      .map((res) => res.status)
      .sort((a, b) => a - b);
    // 一个 201，一个 409/400（不能两个都成功）
    expect(codes[0]).toBe(201);
    expect(codes[1]).toBeGreaterThanOrEqual(400);

    // 无论谁在并发中胜出，持有人都不能审批自己发起的申请——由销售2重新申请后再审批
    const pendingNow = await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales1))
      .expect(200);
    if (pendingNow.body.data.pendingRequest.requesterId === sales1.id) {
      await request(app.getHttpServer())
        .post(`/api/v1/cms/samples/requests/${pendingNow.body.data.pendingRequest.id}/withdraw`)
        .set(auth(sales1))
        .expect(201);
      const fresh = await request(app.getHttpServer())
        .post(`/api/v1/cms/samples/${sampleId}/requests`)
        .set(auth(sales2))
        .send({ purpose: '并发后重新申请' })
        .expect(201);
      requestId = fresh.body.data.id;
    } else {
      requestId = pendingNow.body.data.pendingRequest.id;
    }
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales1))
      .expect(200);
    expect(detail.body.data.status).toBe('REQUEST_OUT');
  });

  it('持有人同意出库：样品从所有正常列表消失、不可再申请；历史申请与日志保留', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/decide`)
      .set(auth(sales1))
      .send({ decision: 'APPROVE' })
      .expect(201);

    // 详情对业务员不可见（正常列表接口不返回 OUT）
    await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales2))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}`)
      .set(auth(sales1))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sampleId}/requests`)
      .set(auth(sales2))
      .send({ purpose: '归档后再申请' })
      .expect(404); // 样品不在可见范围

    // 管理员归档历史仍可查
    const archive = await request(app.getHttpServer())
      .get('/api/v1/cms/samples/archive')
      .set(auth(admin))
      .expect(200);
    expect(archive.body.data.items.some((s: { id: string }) => s.id === sampleId)).toBe(true);

    // 历史申请记录保留（管理员 scope=all）
    const all = await request(app.getHttpServer())
      .get('/api/v1/cms/samples/requests?scope=all')
      .set(auth(admin))
      .expect(200);
    const history = all.body.data.items.filter(
      (r: { sampleId: string }) => r.sampleId === sampleId,
    );
    expect(history.length).toBeGreaterThanOrEqual(3); // 撤回 + 拒绝 + 同意
    expect(history.some((r: { status: string }) => r.status === 'WITHDRAWN')).toBe(true);
    expect(history.some((r: { status: string }) => r.status === 'REJECTED')).toBe(true);
    expect(history.some((r: { status: string }) => r.status === 'APPROVED')).toBe(true);

    // 操作日志保留
    const logs = await request(app.getHttpServer())
      .get(`/api/v1/cms/samples/${sampleId}/logs`)
      .set(auth(admin))
      .expect(200);
    expect(logs.body.data.length).toBeGreaterThanOrEqual(2);

    // 已同意的申请不能重复审批
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${requestId}/decide`)
      .set(auth(sales1))
      .send({ decision: 'APPROVE' })
      .expect(409);
  });

  it('持有人给自己样品发起申请时，不能审批自己（防自批）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/samples')
      .set(auth(sales1))
      .send({ name: `自批防护-${RUN_ID}`, quantity: 1, unit: '片', location: 'B区' })
      .expect(201);
    const sid = res.body.data.id;
    const req = await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${sid}/requests`)
      .set(auth(sales1))
      .send({ purpose: '持有自己样品的申请' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${req.body.data.id}/decide`)
      .set(auth(sales1))
      .send({ decision: 'APPROVE' })
      .expect(403);
    // 撤回恢复，避免残留 REQUEST_OUT 状态样品
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/requests/${req.body.data.id}/withdraw`)
      .set(auth(sales1))
      .expect(201);
  });

  it('状态不允许任意文本更新（Update DTO 无 status 字段，403/400）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/samples')
      .set(auth(sales1))
      .send({ name: `状态防护-${RUN_ID}`, quantity: 1, unit: '片', location: 'C区' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/samples/${res.body.data.id}`)
      .set(auth(sales1))
      .send({ status: 'IN_STOCK', name: 'x' })
      .expect(400); // forbidNonWhitelisted
  });

  it('待审批列表：持有人 scope=pending 只看到针对自己样品的申请', async () => {
    // 新样品 + 被授权人申请
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/samples')
      .set(auth(sales1))
      .send({ name: `待审批-${RUN_ID}`, quantity: 2, unit: '张', location: 'D区' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${res.body.data.id}/grants`)
      .set(auth(admin))
      .send({ userIds: [sales2.id] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/cms/samples/${res.body.data.id}/requests`)
      .set(auth(sales2))
      .send({ purpose: '待审批列表验证' })
      .expect(201);

    const pending = await request(app.getHttpServer())
      .get('/api/v1/cms/samples/requests?scope=pending')
      .set(auth(sales1))
      .expect(200);
    expect(
      pending.body.data.items.some(
        (r: { sampleId: string }) => r.sampleId === res.body.data.id,
      ),
    ).toBe(true);

    const pending3 = await request(app.getHttpServer())
      .get('/api/v1/cms/samples/requests?scope=pending')
      .set(auth(sales3))
      .expect(200);
    expect(pending3.body.data.items.length).toBe(0);

    // sales2 的「我的申请」
    const mine = await request(app.getHttpServer())
      .get('/api/v1/cms/samples/requests?scope=mine')
      .set(auth(sales2))
      .expect(200);
    expect(
      mine.body.data.items.some((r: { sampleId: string }) => r.sampleId === res.body.data.id),
    ).toBe(true);

    // 业务员不能看全部
    await request(app.getHttpServer())
      .get('/api/v1/cms/samples/requests?scope=all')
      .set(auth(sales2))
      .expect(403);
  });
});
