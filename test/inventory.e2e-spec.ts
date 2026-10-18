import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';

/**
 * 库存管理 e2e（Phase 5.3，单仓库）。
 *
 * 覆盖：CRUD 与字段白名单、数量 Decimal 精度与非负校验、单位白名单、
 * 关联订单校验（存在 + 权限）、越权读写删、从订单创建库存的自动关联、
 * 删除不影响订单与附件、列表筛选（编号/关键词/位置/日期范围/订单号）、
 * 分页、订单关联库存查询接口、审计日志。
 */

const PREFIX = 'e2e-inventory';
const RUN_ID = Date.now().toString(36);

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe('Inventory CMS（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: TestUser;
  let salesA: TestUser; // 库存创建人 / 订单归属
  let salesB: TestUser; // 他人
  let orderAId: string;
  let orderACode: string;
  let itemId: string;

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

  /** 通过真实订单接口为 salesA 建一单（订单号手动填写） */
  async function createOrderFor(u: TestUser, code: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/orders')
      .set(auth(u))
      .send({
        code,
        customerName: `库存联调客户-${RUN_ID}`,
        country: 'China',
        requirement: '为库存关联测试下单',
        orderedAt: '2026-10-01',
        amount: 100,
        currency: 'CNY',
      })
      .expect(201);
    return res.body.data.id;
  }

  const createItem = (u: TestUser, overrides: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/api/v1/cms/inventory')
      .set(auth(u))
      .send({
        productName: `胡桃木面板-${RUN_ID}`,
        productDetail: '1220x2440x18mm 胡桃木贴面 MDF',
        quantity: 120,
        unit: '张',
        location: 'A区-3号货架-2层',
        storedAt: '2026-10-01',
        ...overrides,
      });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // 清理历史残留（先库存后订单：库存外键 Restrict）
    const stale = await prisma.adminUser.findMany({
      where: { email: { contains: `${PREFIX}-` } },
      select: { id: true },
    });
    for (const u of stale) {
      await prisma.inventoryItem.deleteMany({ where: { createdById: u.id } });
      await prisma.orderAttachment.deleteMany({ where: { uploadedById: u.id } });
      await prisma.order.deleteMany({ where: { salespersonId: u.id } });
      await prisma.adminUser.deleteMany({ where: { id: u.id } });
    }

    admin = await makeUser('admin', AdminRole.ADMIN);
    salesA = await makeUser('salesa', AdminRole.EDITOR);
    salesB = await makeUser('salesb', AdminRole.EDITOR);
  }, 60_000);

  afterAll(async () => {
    const users = [admin, salesA, salesB];
    for (const u of users) {
      await prisma.inventoryItem.deleteMany({ where: { createdById: u.id } });
      await prisma.orderAttachment.deleteMany({ where: { uploadedById: u.id } });
      await prisma.order.deleteMany({ where: { salespersonId: u.id } });
    }
    await prisma.adminUser.deleteMany({ where: { email: { contains: `${PREFIX}-` } } });
    await app.close();
  });

  /* ---------------------------- 基础 CRUD ---------------------------- */

  it('业务员新增库存：编号自动生成、创建人为本人、未关联订单', async () => {
    const res = await createItem(salesA).expect(201);
    itemId = res.body.data.id;
    expect(res.body.data.code).toMatch(/^INV-\d{8}-[A-F0-9]{6}$/);
    expect(res.body.data.createdById).toBe(salesA.id);
    expect(res.body.data.orderId).toBeNull();
    expect(res.body.data.orderCode).toBeNull();
    expect(res.body.data.quantity).toBe('120');
  });

  it('数量为非负 Decimal：三位小数精确保存，尾零不展示；负数/超精度被拒', async () => {
    const frac = await createItem(salesA, { quantity: 12.125 }).expect(201);
    expect(frac.body.data.quantity).toBe('12.125');

    const whole = await createItem(salesA, { quantity: 5.000 }).expect(201);
    expect(whole.body.data.productName).toContain('胡桃木');
    expect(whole.body.data.quantity).toBe('5');

    await createItem(salesA, { quantity: -1 }).expect(400);
    await createItem(salesA, { quantity: 1.2345 }).expect(400);
  });

  it('字段校验：名称/详情/位置/单位/日期缺失或非法被拒', async () => {
    await createItem(salesA, { productName: '' }).expect(400);
    await createItem(salesA, { productDetail: '' }).expect(400);
    await createItem(salesA, { location: '' }).expect(400);
    await createItem(salesA, { unit: '箱' }).expect(400);
    await createItem(salesA, { storedAt: 'not-a-date' }).expect(400);
    await createItem(salesA, { quantity: '一百' }).expect(400);
  });

  it('编辑库存：白名单字段可改；code / createdById 提交被拒', async () => {
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/cms/inventory/${itemId}`)
      .set(auth(salesA))
      .send({
        productName: `胡桃木面板-改-${RUN_ID}`,
        productDetail: '18mm 胡桃木贴面',
        quantity: 66.5,
        unit: '片',
        location: 'B区-1号货架-1层',
        storedAt: '2026-10-08',
      })
      .expect(200);
    expect(updated.body.data.quantity).toBe('66.5');
    expect(updated.body.data.unit).toBe('片');
    expect(updated.body.data.location).toContain('B区');
    // 库存编号与创建人不可通过接口变更
    expect(updated.body.data.code).toMatch(/^INV-/);
    expect(updated.body.data.createdById).toBe(salesA.id);

    await request(app.getHttpServer())
      .patch(`/api/v1/cms/inventory/${itemId}`)
      .set(auth(salesA))
      .send({
        code: 'INV-HACKED-0001',
        createdById: salesB.id,
        productName: 'x',
        productDetail: 'x',
        quantity: 1,
        unit: '张',
        location: 'x',
        storedAt: '2026-10-01',
      })
      .expect(400);
  });

  it('越权：他人库存不可见（详情 404）、不可编辑、不可删除', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory/${itemId}`)
      .set(auth(salesB))
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/inventory/${itemId}`)
      .set(auth(salesB))
      .send({
        productName: 'x',
        productDetail: 'x',
        quantity: 1,
        unit: '张',
        location: 'x',
        storedAt: '2026-10-01',
      })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/inventory/${itemId}`)
      .set(auth(salesB))
      .expect(403);
  });

  /* ------------------------ 订单关联（核心入口） ------------------------ */

  it('从订单创建库存：自动关联订单，订单号从关联订单读取', async () => {
    orderACode = `E2E-INV-ORD-${RUN_ID}`;
    orderAId = await createOrderFor(salesA, orderACode);

    const res = await createItem(salesA, { orderId: orderAId }).expect(201);
    expect(res.body.data.orderId).toBe(orderAId);
    expect(res.body.data.orderCode).toBe(orderACode);

    // 订单详情接口返回该订单的库存（含刚创建的）
    const byOrder = await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory/orders/${orderAId}`)
      .set(auth(salesA))
      .expect(200);
    expect(byOrder.body.data.some((i: { id: string }) => i.id === res.body.data.id)).toBe(true);

    // 他人订单详情接口 → 404
    await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory/orders/${orderAId}`)
      .set(auth(salesB))
      .expect(404);
  });

  it('伪造关联被拒：不存在的订单 400；他人订单 403', async () => {
    await createItem(salesA, { orderId: 'no-such-order-id' }).expect(400);

    // salesB 自己的订单，salesA 无权关联
    const foreignOrderId = await createOrderFor(salesB, `E2E-INV-ORD-B-${RUN_ID}`);
    await createItem(salesA, { orderId: foreignOrderId }).expect(403);

    // 管理员可为他人订单关联库存（管理员能力）
    await createItem(admin, { orderId: foreignOrderId }).expect(201);
  });

  it('删除库存：记录不再展示；订单与订单附件不受影响', async () => {
    const created = await createItem(salesA, { orderId: orderAId }).expect(201);
    const del = await request(app.getHttpServer())
      .delete(`/api/v1/cms/inventory/${created.body.data.id}`)
      .set(auth(salesA))
      .expect(200);
    expect(del.body.data.code).toBe(created.body.data.code);

    await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory/${created.body.data.id}`)
      .set(auth(salesA))
      .expect(404);

    // 订单仍在且可读（删除库存不得级联删除订单）
    const order = await request(app.getHttpServer())
      .get(`/api/v1/cms/orders/${orderAId}`)
      .set(auth(salesA))
      .expect(200);
    expect(order.body.data.code).toBe(orderACode);
  });

  /* ---------------------------- 列表与筛选 ---------------------------- */

  it('列表筛选：库存编号精确、关键词、位置、存放日期范围', async () => {
    const byCode = await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory?code=${encodeURIComponent((await createItem(salesA).expect(201)).body.data.code)}`)
      .set(auth(salesA))
      .expect(200);
    expect(byCode.body.data.total).toBe(1);

    const byKeyword = await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory?keyword=${encodeURIComponent(`胡桃木面板-改-${RUN_ID}`)}`)
      .set(auth(salesA))
      .expect(200);
    expect(byKeyword.body.data.items.every((i: { productName: string }) => i.productName.includes('改'))).toBe(true);

    const byLocation = await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory?location=${encodeURIComponent('B区-1号货架')}`)
      .set(auth(salesA))
      .expect(200);
    expect(byLocation.body.data.items.every((i: { location: string }) => i.location.includes('B区-1号货架'))).toBe(true);

    const byDate = await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory?storedFrom=2026-10-05&storedTo=2026-10-09`)
      .set(auth(salesA))
      .expect(200);
    expect(byDate.body.data.total).toBeGreaterThan(0);

    const none = await request(app.getHttpServer())
      .get('/api/v1/cms/inventory?location=不存在的库位')
      .set(auth(salesA))
      .expect(200);
    expect(none.body.data.total).toBe(0);
  });

  it('列表筛选：按关联订单号查询；他人订单号查不到（不泄漏）', async () => {
    const byOrderCode = await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory?orderCode=${encodeURIComponent(orderACode)}`)
      .set(auth(salesA))
      .expect(200);
    expect(byOrderCode.body.data.items.every((i: { orderCode: string }) => i.orderCode === orderACode)).toBe(true);

    // salesB 的订单号：salesA 查不到任何库存
    const foreign = await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory?orderCode=${encodeURIComponent(`E2E-INV-ORD-B-${RUN_ID}`)}`)
      .set(auth(salesA))
      .expect(200);
    expect(foreign.body.data.total).toBe(0);

    // 管理员可按任意订单号查询
    const adminBy = await request(app.getHttpServer())
      .get(`/api/v1/cms/inventory?orderCode=${encodeURIComponent(`E2E-INV-ORD-B-${RUN_ID}`)}`)
      .set(auth(admin))
      .expect(200);
    expect(adminBy.body.data.total).toBeGreaterThan(0);
  });

  it('权限隔离：业务员只能看到自己的库存；管理员可见全部', async () => {
    const bList = await request(app.getHttpServer())
      .get('/api/v1/cms/inventory')
      .set(auth(salesB))
      .expect(200);
    expect(bList.body.data.items.every((i: { createdById: string }) => i.createdById === salesB.id)).toBe(true);

    const adminList = await request(app.getHttpServer())
      .get('/api/v1/cms/inventory')
      .set(auth(admin))
      .expect(200);
    expect(adminList.body.data.total).toBeGreaterThan(0);
  });

  it('分页：limit=1 时 totalPages 正确', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/cms/inventory?page=1&limit=1')
      .set(auth(salesA))
      .expect(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.totalPages).toBe(Math.max(1, Math.ceil(res.body.data.total / 1)));
  });

  it('审计日志：创建/编辑/删除均记录在案', async () => {
    const logs = await prisma.auditLog.findMany({
      where: { targetType: 'inventory_item', actorId: salesA.id },
      orderBy: { createdAt: 'asc' },
    });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('inventory.create');
    expect(actions).toContain('inventory.update');
    expect(actions).toContain('inventory.delete');
  });
});
