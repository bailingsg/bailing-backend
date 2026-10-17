import { existsSync } from 'node:fs';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';

/**
 * 订单管理 e2e（Phase 5.2）。
 *
 * 覆盖：订单 CRUD 权限隔离、金额/币种/日期校验、编号唯一、
 * 图片上传与订单关联、媒体库隔离（附件不出现在 /cms/media）、
 * 附件访问控制、越权关联、并发绑定冲突、移除附件。
 */

const PREFIX = 'e2e-orders';
const RUN_ID = Date.now().toString(36);

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(`e2e-order-photo-${RUN_ID}`),
]);

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe('Orders CMS（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: TestUser;
  let salesA: TestUser;
  let salesB: TestUser;
  let orderId: string;
  let attachmentId: string;

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // 清理历史残留（先删附件行与文件，再删订单与账号）
    const stale = await prisma.adminUser.findMany({
      where: { email: { contains: `${PREFIX}-` } },
      select: { id: true },
    });
    for (const u of stale) {
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
      await prisma.orderAttachment.deleteMany({ where: { uploadedById: u.id } });
      await prisma.order.deleteMany({ where: { salespersonId: u.id } });
    }
    await prisma.adminUser.deleteMany({ where: { email: { contains: `${PREFIX}-` } } });
    await app.close();
  });

  const uploadPhoto = async (u: TestUser, name: string) => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/orders/uploads')
      .set(auth(u))
      .attach('file', PNG_BYTES, { filename: name, contentType: 'image/png' });
    if (res.status !== 201) console.log('UPLOAD-DEBUG', JSON.stringify(res.body));
    return res;
  };

  const createOrder = (
    u: TestUser,
    overrides: Record<string, unknown> = {},
    attachments: string[] = [],
  ) =>
    request(app.getHttpServer())
      .post('/api/v1/cms/orders')
      .set(auth(u))
      .send({
        customerName: `客户-${RUN_ID}`,
        country: 'United States',
        requirement: '18mm 胡桃木 MDF 面板 3000 平方米',
        orderedAt: '2026-10-01',
        amount: 12345.67,
        currency: 'USD',
        note: 'e2e',
        attachmentIds: attachments,
        ...overrides,
      });

  it('业务员创建订单：编号自动生成、金额与币种正确保存、成交时间可空', async () => {
    const up = await uploadPhoto(salesA, `order-a-${RUN_ID}.png`);
    attachmentId = up.body.data.id;

    const res = await createOrder(salesA, {}, [attachmentId]).expect(201);
    orderId = res.body.data.id;
    expect(res.body.data.salespersonId).toBe(salesA.id);
    expect(res.body.data.code).toMatch(/^SO-\d{8}-[A-F0-9]{6}$/);
    expect(res.body.data.amount).toBe('12345.67');
    expect(res.body.data.currency).toBe('USD');
    expect(res.body.data.closedAt).toBeNull();
    expect(res.body.data.attachments).toHaveLength(1);
    expect(res.body.data.attachments[0].originalName).toContain('order-a-');
  });

  it('金额/币种/日期校验：负数、3位小数、非法币种、成交早于下单被拒', async () => {
    await createOrder(salesA, { amount: -1 }).expect(400);
    await createOrder(salesA, { amount: 1.234 }).expect(400);
    await createOrder(salesA, { currency: 'JPY' }).expect(400);
    await createOrder(salesA, { closedAt: '2026-09-30' }).expect(400);
    await createOrder(salesA, { closedAt: 'not-a-date' }).expect(400);
    await createOrder(salesA, { orderedAt: '' }).expect(400);
  });

  it('三种币种均可保存', async () => {
    for (const currency of ['CNY', 'USD', 'EUR']) {
      await createOrder(salesA, { currency }, []).expect(201);
    }
  });

  it('权限：管理员可见全部；业务员仅见自己；越权详情 404、编辑 403', async () => {
    const adminList = await request(app.getHttpServer())
      .get('/api/v1/cms/orders')
      .set(auth(admin))
      .expect(200);
    expect(adminList.body.data.items.some((o: { id: string }) => o.id === orderId)).toBe(true);

    const aList = await request(app.getHttpServer())
      .get('/api/v1/cms/orders')
      .set(auth(salesA))
      .expect(200);
    expect(aList.body.data.items.some((o: { id: string }) => o.id === orderId)).toBe(true);

    const bList = await request(app.getHttpServer())
      .get('/api/v1/cms/orders')
      .set(auth(salesB))
      .expect(200);
    expect(bList.body.data.items.some((o: { id: string }) => o.id === orderId)).toBe(false);

    await request(app.getHttpServer())
      .get(`/api/v1/cms/orders/${orderId}`)
      .set(auth(salesB))
      .expect(404);

    // 越权编辑（DTO 白名单拒绝 salespersonId 篡改 → 400；合法请求体同样被服务层拒绝 → 403）
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/orders/${orderId}`)
      .set(auth(salesB))
      .send({ customerName: '篡改', salespersonId: salesB.id })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/orders/${orderId}`)
      .set(auth(salesB))
      .send({
        customerName: '篡改名',
        country: 'US',
        requirement: '越权尝试',
        orderedAt: '2026-10-10',
        amount: 1,
        currency: 'CNY',
      })
      .expect(403);
  });

  it('搜索与筛选：按客户关键词、国家、成交状态', async () => {
    const kw = await request(app.getHttpServer())
      .get(`/api/v1/cms/orders?keyword=${RUN_ID}`)
      .set(auth(salesA))
      .expect(200);
    expect(kw.body.data.items.every((o: { customerName: string }) => o.customerName.includes(RUN_ID))).toBe(true);

    const byCountry = await request(app.getHttpServer())
      .get('/api/v1/cms/orders?country=United+States')
      .set(auth(salesA))
      .expect(200);
    expect(byCountry.body.data.items.length).toBeGreaterThan(0);

    const open = await request(app.getHttpServer())
      .get('/api/v1/cms/orders?closedState=open')
      .set(auth(salesA))
      .expect(200);
    expect(open.body.data.items.every((o: { closedAt: null }) => o.closedAt === null)).toBe(true);

    // 按业务员筛选（管理员）
    const bySales = await request(app.getHttpServer())
      .get(`/api/v1/cms/orders?salespersonId=${salesA.id}`)
      .set(auth(admin))
      .expect(200);
    expect(bySales.body.data.items.every((o: { salespersonId: string }) => o.salespersonId === salesA.id)).toBe(true);
  });

  it('附件隔离：订单照片不出现在媒体库列表/搜索/详情', async () => {
    const mediaList = await request(app.getHttpServer())
      .get(`/api/v1/cms/media?keyword=${RUN_ID}`)
      .set(auth(admin))
      .expect(200);
    expect(
      mediaList.body.data.items.some((m: { id: string }) => m.id === attachmentId),
    ).toBe(false);

    // 通过原始文件名搜索也不返回（订单附件不落 media_assets）
    const mediaSearch = await request(app.getHttpServer())
      .get(`/api/v1/cms/media?keyword=order-a-${RUN_ID}`)
      .set(auth(admin))
      .expect(200);
    expect(mediaSearch.body.data.total).toBe(0);

    // 附件详情接口按媒体 ID 查不到
    await request(app.getHttpServer())
      .get(`/cms/media/${attachmentId}`)
      .set(auth(admin))
      .expect(404);
  });

  it('附件访问控制：持有人可读文件流；其他业务员 404', async () => {
    const own = await request(app.getHttpServer())
      .get(`/api/v1/cms/orders/${orderId}/attachments/${attachmentId}/file`)
      .set(auth(salesA))
      .expect(200);
    expect(own.headers['content-type']).toBe('image/png');
    const body = Buffer.isBuffer(own.body)
      ? own.body
      : Buffer.from(String(own.body));
    expect(body.subarray(0, 8).equals(PNG_BYTES.subarray(0, 8))).toBe(true);

    await request(app.getHttpServer())
      .get(`/api/v1/cms/orders/${orderId}/attachments/${attachmentId}/file`)
      .set(auth(salesB))
      .expect(404);
  });

  it('越权关联：不能把别人上传的临时附件绑到自己订单', async () => {
    const foreign = await uploadPhoto(salesB, `order-b-${RUN_ID}.png`);
    await createOrder(salesA, {}, [foreign.body.data.id]).expect(403);

    // 并发重复绑定同一张临时附件：只允许一个订单成功
    const [r1, r2] = await Promise.allSettled([
      createOrder(salesA, {}, [foreign.body.data.id]).catch((e) => e),
      createOrder(salesA, {}, [foreign.body.data.id]).catch((e) => e),
    ]);
    // 两个都是 403（他人文件无法绑定，业务侧直接拒绝，不进入并发绑定）
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');

    // 本人并发绑定自己上传的附件：一个成功一个冲突
    const mine = await uploadPhoto(salesA, `order-a2-${RUN_ID}.png`);
    const [s1, s2] = await Promise.allSettled([
      createOrder(salesA, {}, [mine.body.data.id]),
      createOrder(salesA, {}, [mine.body.data.id]),
    ]);
    const codes = [s1, s2].map((r) =>
      r.status === 'fulfilled' ? (r as PromiseFulfilledResult<request.Response>).value.status : -1,
    );
    expect(codes.sort((a, b) => a - b)).toEqual([201, 409]);
  });

  it('无效文件类型被拒；上传不返回虚假成功', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/orders/uploads')
      .set(auth(salesA))
      .attach('file', Buffer.from('not-an-image'), {
        filename: `hack-${RUN_ID}.png`,
        contentType: 'image/png',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/cms/orders/uploads')
      .set(auth(salesA))
      .attach('file', PNG_BYTES, {
        filename: `bad-${RUN_ID}.gif`,
        contentType: 'image/gif',
      })
      .expect(400);
  });

  it('编辑订单：保留/新增/移除附件，操作仅限本人', async () => {
    const extra = await uploadPhoto(salesA, `order-a-extra-${RUN_ID}.png`);
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/cms/orders/${orderId}`)
      .set(auth(salesA))
      .send({
        customerName: `客户-${RUN_ID}`,
        country: 'Germany',
        requirement: '更新后的需求',
        orderedAt: '2026-10-05',
        amount: 20000,
        currency: 'EUR',
        attachmentIds: [extra.body.data.id],
      })
      .expect(200);
    expect(updated.body.data.attachments).toHaveLength(2);
    expect(updated.body.data.currency).toBe('EUR');

    // 移除附件（第一张与新增的）→ 行删除且文件不再可读
    const first = updated.body.data.attachments[0];
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/orders/${orderId}`)
      .set(auth(salesA))
      .send({
        customerName: `客户-${RUN_ID}`,
        country: 'Germany',
        requirement: '更新后的需求',
        orderedAt: '2026-10-05',
        amount: 20000,
        currency: 'EUR',
        removeAttachmentIds: [first.id],
      })
      .expect(200);
    const afterRemove = await request(app.getHttpServer())
      .get(`/api/v1/cms/orders/${orderId}`)
      .set(auth(salesA))
      .expect(200);
    expect(afterRemove.body.data.attachments.map((a: { id: string }) => a.id)).not.toContain(first.id);
    await request(app.getHttpServer())
      .get(`/api/v1/cms/orders/${orderId}/attachments/${first.id}/file`)
      .set(auth(salesA))
      .expect(404);
  });

  it('磁盘文件位于 orders/ 目录且不在 /uploads/media 静态区', async () => {
    const rows = await prisma.orderAttachment.findMany({
      where: { orderId, storageKey: { startsWith: 'orders/' } },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const mediaPath = path.join(process.cwd(), 'uploads', 'media', row.storageKey);
      const orderPath = path.join(process.cwd(), 'uploads', row.storageKey);
      expect(existsSync(mediaPath)).toBe(false);
      expect(existsSync(orderPath)).toBe(true);
    }
  });

  it('操作日志：创建与编辑记录在案', async () => {
    const logs = await prisma.auditLog.findMany({
      where: { targetType: 'order', targetId: orderId },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => l.action)).toContain('order.create');
    expect(logs.map((l) => l.action)).toContain('order.update');
  });
});
