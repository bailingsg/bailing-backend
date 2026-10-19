import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';

/**
 * 订单表单联动库存 e2e（Phase 5.3.2）。
 *
 * 覆盖：订单与库存在同一事务内创建（失败不残留）、编辑时更新而非重复新增、
 * 未传 inventory 时库存不被静默删除、removeInventory 显式删除、互斥参数拒绝、
 * 越权保护、以及库存删除不级联影响订单。
 */

const PREFIX = 'e2e-order-inv';
const RUN_ID = Date.now().toString(36);

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe('订单联动库存（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: TestUser;
  let salesA: TestUser;
  let salesB: TestUser;

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

  let codeSeq = 0;
  const nextCode = () => `E2E-OINV-${RUN_ID}-${++codeSeq}`;

  const inventoryPayload = (overrides: Record<string, unknown> = {}) => ({
    productName: `联调面板-${RUN_ID}`,
    productDetail: '1220x2440x18mm 胡桃木贴面 MDF',
    quantity: 88.5,
    unit: '张',
    location: 'C区-2号货架-1层',
    storedAt: '2026-10-10',
    ...overrides,
  });

  const baseOrder = (overrides: Record<string, unknown> = {}) => ({
    code: nextCode(),
    customerName: `联动客户-${RUN_ID}`,
    country: 'United States',
    requirement: '订单表单联动库存测试',
    orderedAt: '2026-10-02',
    amount: 1234.56,
    currency: 'USD',
    ...overrides,
  });

  const createOrder = (u: TestUser, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/v1/cms/orders').set(auth(u)).send(body);

  const updateOrder = (u: TestUser, id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).patch(`/api/v1/cms/orders/${id}`).set(auth(u)).send(body);

  const listInventoryOfOrder = (u: TestUser, orderId: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/cms/inventory/orders/${orderId}`)
      .set(auth(u));

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
    for (const u of [admin, salesA, salesB]) {
      await prisma.inventoryItem.deleteMany({ where: { createdById: u.id } });
      await prisma.orderAttachment.deleteMany({ where: { uploadedById: u.id } });
      await prisma.order.deleteMany({ where: { salespersonId: u.id } });
    }
    await prisma.adminUser.deleteMany({ where: { email: { contains: `${PREFIX}-` } } });
    await app.close();
  });

  /* ------------------------- 新建：同事务写入 ------------------------- */

  it('新建订单同时创建库存：自动关联订单、编号由系统生成、创建人为本人', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const res = await createOrder(salesA, body).expect(201);
    const orderId = res.body.data.id;

    const inventory = await listInventoryOfOrder(salesA, orderId).expect(200);
    expect(inventory.body.data).toHaveLength(1);
    const item = inventory.body.data[0];
    expect(item.code).toMatch(/^INV-\d{8}-[A-F0-9]{6}$/);
    expect(item.orderId).toBe(orderId);
    expect(item.orderCode).toBe(body.code);
    expect(item.createdById).toBe(salesA.id);
    expect(item.quantity).toBe('88.5');
    expect(item.unit).toBe('张');
    expect(item.location).toBe('C区-2号货架-1层');
    expect(item.productName).toBe(`联调面板-${RUN_ID}`);

    // 订单响应体不夹带库存字段（库存仍由独立接口输出）
    expect(res.body.data.inventory).toBeUndefined();
  }, 30_000);

  it('库存字段非法时整体失败：订单不落库（无残留）', async () => {
    const cases: Record<string, unknown>[] = [
      inventoryPayload({ unit: '箱' }),
      inventoryPayload({ quantity: -1 }),
      inventoryPayload({ quantity: 1.2345 }),
      inventoryPayload({ productName: '' }),
      inventoryPayload({ location: '' }),
      inventoryPayload({ storedAt: 'not-a-date' }),
      inventoryPayload({ productDetail: '' }),
    ];
    for (const inventory of cases) {
      const body = baseOrder({ inventory });
      await createOrder(salesA, body).expect(400);
      const order = await prisma.order.findUnique({ where: { code: body.code } });
      expect(order).toBeNull();
    }
  }, 60_000);

  it('订单号重复且带库存：409，且不产生任何库存行', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const first = await createOrder(salesA, body).expect(201);

    const before = await prisma.inventoryItem.count({ where: { createdById: salesA.id } });
    const duplicated = baseOrder({ code: body.code, inventory: inventoryPayload() });
    const res = await createOrder(salesA, duplicated);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('该订单号已存在');
    const after = await prisma.inventoryItem.count({ where: { createdById: salesA.id } });
    expect(after).toBe(before);

    // 原订单的库存数量不变
    const inventory = await listInventoryOfOrder(salesA, first.body.data.id).expect(200);
    expect(inventory.body.data).toHaveLength(1);
  }, 30_000);

  it('不传 inventory：订单照常创建，且不产生库存', async () => {
    const body = baseOrder();
    const res = await createOrder(salesA, body).expect(201);
    const inventory = await listInventoryOfOrder(salesA, res.body.data.id).expect(200);
    expect(inventory.body.data).toHaveLength(0);
  }, 30_000);

  /* ------------------------- 编辑：更新不新增 ------------------------- */

  it('编辑订单携带库存：更新原记录（不重复新增）', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const created = await createOrder(salesA, body).expect(201);
    const orderId = created.body.data.id;
    const before = await listInventoryOfOrder(salesA, orderId).expect(200);
    const originalId = before.body.data[0].id;
    const originalCode = before.body.data[0].code;

    const updated = await updateOrder(salesA, orderId, {
      customerName: `联动客户改-${RUN_ID}`,
      country: 'Canada',
      requirement: '改后的需求',
      orderedAt: '2026-10-03',
      amount: 999.99,
      currency: 'CNY',
      inventory: inventoryPayload({
        productName: `联调面板-改-${RUN_ID}`,
        quantity: 12.125,
        unit: '片',
        location: 'D区-1号货架',
        storedAt: '2026-10-12',
      }),
    }).expect(200);
    expect(updated.body.data.customerName).toBe(`联动客户改-${RUN_ID}`);

    const after = await listInventoryOfOrder(salesA, orderId).expect(200);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].id).toBe(originalId);
    expect(after.body.data[0].code).toBe(originalCode);
    expect(after.body.data[0].quantity).toBe('12.125');
    expect(after.body.data[0].unit).toBe('片');
    expect(after.body.data[0].location).toBe('D区-1号货架');
  }, 30_000);

  it('编辑订单不传 inventory：已有库存保持不变（不静默删除）', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const created = await createOrder(salesA, body).expect(201);
    const orderId = created.body.data.id;
    const before = await listInventoryOfOrder(salesA, orderId).expect(200);

    await updateOrder(salesA, orderId, {
      customerName: `静默删除验证-${RUN_ID}`,
      country: 'Japan',
      requirement: '只改订单字段',
      orderedAt: '2026-10-04',
      amount: 1,
      currency: 'EUR',
    }).expect(200);

    const after = await listInventoryOfOrder(salesA, orderId).expect(200);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].id).toBe(before.body.data[0].id);
    expect(after.body.data[0].quantity).toBe(before.body.data[0].quantity);
  }, 30_000);

  it('订单原本无库存，编辑时填写库存：新建一条并关联', async () => {
    const body = baseOrder();
    const created = await createOrder(salesA, body).expect(201);
    const orderId = created.body.data.id;

    await updateOrder(salesA, orderId, {
      customerName: body.customerName,
      country: body.country,
      requirement: body.requirement,
      orderedAt: '2026-10-02',
      amount: 10,
      currency: 'USD',
      inventory: inventoryPayload({ quantity: 3 }),
    }).expect(200);

    const after = await listInventoryOfOrder(salesA, orderId).expect(200);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].orderId).toBe(orderId);
    expect(after.body.data[0].quantity).toBe('3');
  }, 30_000);

  /* ------------------------- 显式删除 ------------------------- */

  it('removeInventory=true：删除主库存，订单本身保留', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const created = await createOrder(salesA, body).expect(201);
    const orderId = created.body.data.id;
    const before = await listInventoryOfOrder(salesA, orderId).expect(200);
    const inventoryId = before.body.data[0].id;

    await updateOrder(salesA, orderId, {
      customerName: body.customerName,
      country: body.country,
      requirement: body.requirement,
      orderedAt: '2026-10-02',
      amount: 10,
      currency: 'USD',
      removeInventory: true,
    }).expect(200);

    const after = await listInventoryOfOrder(salesA, orderId).expect(200);
    expect(after.body.data).toHaveLength(0);

    // 订单仍在，且可正常读取
    const order = await request(app.getHttpServer())
      .get(`/api/v1/cms/orders/${orderId}`)
      .set(auth(salesA))
      .expect(200);
    expect(order.body.data.code).toBe(body.code);
    expect(await prisma.inventoryItem.findUnique({ where: { id: inventoryId } })).toBeNull();
  }, 30_000);

  it('removeInventory 与 inventory 同时提交：400（语义互斥）', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const created = await createOrder(salesA, body).expect(201);
    await updateOrder(salesA, created.body.data.id, {
      customerName: body.customerName,
      country: body.country,
      requirement: body.requirement,
      orderedAt: '2026-10-02',
      amount: 10,
      currency: 'USD',
      inventory: inventoryPayload(),
      removeInventory: true,
    }).expect(400);

    const after = await listInventoryOfOrder(salesA, created.body.data.id).expect(200);
    expect(after.body.data).toHaveLength(1);
  }, 30_000);

  /* ------------------------- 权限 ------------------------- */

  it('他人订单：编辑被拒（403），且不影响其库存', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const created = await createOrder(salesA, body).expect(201);
    const orderId = created.body.data.id;

    await updateOrder(salesB, orderId, {
      customerName: 'hijack',
      country: 'Nowhere',
      requirement: 'hijack',
      orderedAt: '2026-10-02',
      amount: 1,
      currency: 'USD',
      removeInventory: true,
    }).expect(403);

    const after = await listInventoryOfOrder(salesA, orderId).expect(200);
    expect(after.body.data).toHaveLength(1);
  }, 30_000);

  it('管理员可编辑他人订单并更新其库存', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const created = await createOrder(salesA, body).expect(201);
    const orderId = created.body.data.id;

    await updateOrder(admin, orderId, {
      customerName: body.customerName,
      country: body.country,
      requirement: body.requirement,
      orderedAt: '2026-10-02',
      amount: 10,
      currency: 'USD',
      inventory: inventoryPayload({ quantity: 7 }),
    }).expect(200);

    const after = await listInventoryOfOrder(salesA, orderId).expect(200);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].quantity).toBe('7');
    // 更新他人订单库存不改变原创建人
    expect(after.body.data[0].createdById).toBe(salesA.id);
  }, 30_000);

  /* ------------------------- 删除库存不影响订单 ------------------------- */

  it('删除库存记录：订单与其它数据不受影响', async () => {
    const body = baseOrder({ inventory: inventoryPayload() });
    const created = await createOrder(salesA, body).expect(201);
    const orderId = created.body.data.id;
    const inventory = await listInventoryOfOrder(salesA, orderId).expect(200);
    const inventoryId = inventory.body.data[0].id;

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/inventory/${inventoryId}`)
      .set(auth(salesA))
      .expect(200);

    const order = await request(app.getHttpServer())
      .get(`/api/v1/cms/orders/${orderId}`)
      .set(auth(salesA))
      .expect(200);
    expect(order.body.data.code).toBe(body.code);
    expect(order.body.data.amount).toBe('1234.56');
    expect(await prisma.inventoryItem.count({ where: { orderId } })).toBe(0);
  }, 30_000);
});
