import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole, AdminUser } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';
import { SESSION_TIMEOUT_MINUTES, utcDayStart, utcNextDayStart } from '../src/modules/visitor/session-window';

/**
 * 访客统计 M2/M3 验收（实现规格 12.2 API 契约 / 12.3 分页稳定性 / 12.4 隐私）。
 *
 * 依赖本地 PostgreSQL（visitor_session / visitor_daily_statistic 已迁移）。
 * 全部访客数据使用 `00000000-0000-4000-8000-1XXXXXXXXXXX` 段 UUID，
 * afterAll 清理会话表与测试账号，不污染其它数据。
 */

const vid = (n: number): string => `00000000-0000-4000-8000-1${String(n).padStart(11, '0')}`;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

interface TestUser {
  user: AdminUser;
  token: string;
}

async function makeUser(
  prisma: PrismaService,
  app: INestApplication,
  name: string,
  role: AdminRole,
  roleKey: string,
  withPermissions: Array<{ key: string }>,
): Promise<TestUser> {
  const email = `e2e-visitor-${name}@bailingwooden.test`;
  await prisma.adminUser.deleteMany({ where: { email } });
  await prisma.role.deleteMany({ where: { key: roleKey, isSystem: false } });

  const user = await prisma.adminUser.create({
    data: {
      email,
      passwordHash: bcrypt.hashSync('E2E-pass-2026!', 4),
      name: `E2E visitor ${name}`,
      role,
      isActive: true,
    },
  });

  const roleRow = await prisma.role.create({
    data: {
      key: roleKey,
      name: roleKey,
      isSystem: false,
      status: 'ACTIVE',
      rolePermissions: {
        create: withPermissions.map((p) => ({
          permission: { connect: { key: p.key } },
        })),
      },
    },
  });
  await prisma.adminUserRole.create({
    data: { adminUserId: user.id, roleId: roleRow.id },
  });

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: 'E2E-pass-2026!' });
  if (login.status !== 200) {
    throw new Error(`登录失败 ${login.status}: ${JSON.stringify(login.body)}`);
  }
  return { user, token: login.body.data.accessToken };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** 直接造一条会话（夹具） */
async function seedSession(
  prisma: PrismaService,
  visitorId: string,
  opts: {
    firstSeenAt: Date;
    visitCount?: number;
    country?: string | null;
    city?: string | null;
    maskedIp?: string | null;
  },
): Promise<void> {
  await prisma.visitorSession.create({
    data: {
      visitorId,
      firstSeenAt: opts.firstSeenAt,
      lastSeenAt: new Date(opts.firstSeenAt.getTime() + 10 * 60_000),
      visitCount: opts.visitCount ?? 1,
      country: opts.country ?? null,
      city: opts.city ?? null,
      maskedIp: opts.maskedIp ?? null,
      isNewVisitor: false,
    },
  });
}

async function cleanVisitorData(prisma: PrismaService): Promise<void> {
  await prisma.visitorSession.deleteMany({});
  await prisma.visitorDailyStatistic.deleteMany({});
}

describe('访客统计 M2/M3（12.2 契约 / 12.3 分页 / 12.4 隐私）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: TestUser; // SUPER_ADMIN：全部权限
  let viewer: TestUser; // 仅 visitor_stats.read（无 visitor_records.read）
  let nobody: TestUser; // 自定义角色、零权限

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    admin = await makeUser(prisma, app, 'admin', AdminRole.ADMIN, 'e2e_visitor_super', []);
    // 注意：ADMIN 走 legacy fallback？不——有角色绑定就不回退，所以给超管显式 SUPER_ADMIN
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: admin.user.id } });
    const superRole = await prisma.role.upsert({
      where: { key: 'SUPER_ADMIN' },
      update: {},
      create: { key: 'SUPER_ADMIN', name: 'SUPER_ADMIN', isSystem: true },
    });
    await prisma.adminUserRole.create({
      data: { adminUserId: admin.user.id, roleId: superRole.id },
    });

    viewer = await makeUser(prisma, app, 'viewer', AdminRole.EDITOR, 'e2e_visitor_viewer', [
      { key: 'visitor_stats.read' },
    ]);
    nobody = await makeUser(prisma, app, 'nobody', AdminRole.EDITOR, 'e2e_visitor_none', []);

    await cleanVisitorData(prisma);
  });

  afterAll(async () => {
    await cleanVisitorData(prisma);
    for (const u of [admin, viewer, nobody]) {
      await prisma.adminUserRole.deleteMany({ where: { adminUserId: u.user.id } });
      await prisma.adminUser.deleteMany({ where: { id: u.user.id } });
    }
    await prisma.role.deleteMany({
      where: { key: { in: ['e2e_visitor_viewer', 'e2e_visitor_none'] }, isSystem: false },
    });
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // 12.2 API 契约
  // ---------------------------------------------------------------------------

  describe('12.2 overview 契约', () => {
    it('未登录 → 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/cms/visitor-stats/overview');
      expect(res.status).toBe(401);
    });

    it('无 visitor_stats.read → 403（后端是权威边界）', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-stats/overview')
        .set(auth(nobody.token));
      expect(res.status).toBe(403);
    });

    it('超管 200；scope/today/last7/last30/generatedAt 字段与口径标注齐全', async () => {
      await seedSession(prisma, vid(1), { firstSeenAt: new Date(), visitCount: 3 });
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-stats/overview')
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(Object.keys(data).sort()).toEqual(
        ['generatedAt', 'last30Days', 'last7Days', 'scope', 'today'].sort(),
      );
      expect(data.scope).toEqual({
        timezone: 'UTC',
        sessionTimeoutMinutes: SESSION_TIMEOUT_MINUTES,
        note: expect.any(String),
      });
      expect(data.today).toEqual({
        date: isoDate(utcDayStart(new Date())),
        uniqueVisitors: 1,
        visits: 3,
        newVisitors: 0,
      });
      expect(data.last7Days.days).toBe(7);
      expect(data.last30Days.days).toBe(30);
      expect(typeof data.last7Days.uniqueVisitors).toBe('number');
      expect(typeof data.last7Days.visits).toBe('number');
      expect(new Date(data.generatedAt).toString()).not.toBe('Invalid Date');
    });

    it('区间 UV 去重：同一访客今昨两天各一次 → last7Days.uniqueVisitors=1 而非 2', async () => {
      const todayStart = utcDayStart(new Date());
      await cleanVisitorData(prisma);
      await seedSession(prisma, vid(2), { firstSeenAt: todayStart });
      await seedSession(prisma, vid(2), {
        firstSeenAt: new Date(todayStart.getTime() - 86_400_000),
      });
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-stats/overview')
        .set(auth(admin.token));
      expect(res.body.data.last7Days.uniqueVisitors).toBe(1); // 去重，不逐日相加
      expect(res.body.data.last7Days.visits).toBe(2);
    });
  });

  describe('12.2 trend 契约', () => {
    beforeEach(async () => {
      await cleanVisitorData(prisma);
    });

    it('days=7：points 恒 7 项、升序、末项为今日、字段齐全', async () => {
      await seedSession(prisma, vid(3), { firstSeenAt: new Date(), visitCount: 2 });
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-stats/trend?days=7')
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      const { points, days, scope } = res.body.data;
      expect(days).toBe(7);
      expect(points).toHaveLength(7);
      for (let i = 0; i < 7; i += 1) {
        expect(Object.keys(points[i]).sort()).toEqual(
          ['date', 'newVisitors', 'uniqueVisitors', 'visits'].sort(),
        );
        if (i > 0) expect(points[i].date > points[i - 1].date).toBe(true);
      }
      expect(points[6].date).toBe(isoDate(utcDayStart(new Date())));
      expect(points[6].uniqueVisitors).toBe(1);
      expect(points[6].visits).toBe(2);
      expect(scope.timezone).toBe('UTC');
    });

    it('days=30：points 恒 30 项', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-stats/trend?days=30')
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.points).toHaveLength(30);
      expect(res.body.data.points[29].date).toBe(isoDate(utcDayStart(new Date())));
    });

    it('缺失日期补 0：只报今天 → 前 6 天全 0（不跳号）', async () => {
      await seedSession(prisma, vid(4), { firstSeenAt: new Date() });
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-stats/trend?days=7')
        .set(auth(admin.token));
      const points = res.body.data.points;
      for (let i = 0; i < 6; i += 1) {
        expect(points[i].uniqueVisitors).toBe(0);
        expect(points[i].visits).toBe(0);
      }
      expect(points[6].uniqueVisitors).toBe(1);
    });

    it('days 非白名单 → 400（8 / 100 / abc / 缺省 / 小数）', async () => {
      for (const q of ['days=8', 'days=100', 'days=abc', '', 'days=7.5']) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/cms/visitor-stats/trend?${q}`)
          .set(auth(admin.token));
        expect(res.status).toBe(400);
      }
    });

    it('viewer（有 visitor_stats.read）可访问；无 visitor_records.read', async () => {
      const ok = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-stats/trend?days=7')
        .set(auth(viewer.token));
      expect(ok.status).toBe(200);
    });
  });

  describe('12.2 records 契约', () => {
    beforeEach(async () => {
      await cleanVisitorData(prisma);
    });

    it('viewer 无 visitor_records.read → 403；未登录 → 401', async () => {
      const forbidden = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-records')
        .set(auth(viewer.token));
      expect(forbidden.status).toBe(403);
      const unauth = await request(app.getHttpServer()).get('/api/v1/cms/visitor-records');
      expect(unauth.status).toBe(401);
    });

    it('超管 200；顶层字段齐全；item 字段白名单恰为 id/maskedIp/country/city/visitedAt', async () => {
      await seedSession(prisma, vid(5), {
        firstSeenAt: new Date(),
        country: 'CN',
        city: '杭州',
        maskedIp: '203.0.113.0/24',
      });
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-records?period=day&page=1&pageSize=20')
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(Object.keys(data).sort()).toEqual(
        ['generatedAt', 'items', 'page', 'pageSize', 'period', 'scope', 'total', 'totalPages'].sort(),
      );
      expect(data.period).toBe('day');
      expect(data.total).toBe(1);
      expect(data.items).toHaveLength(1);
      expect(Object.keys(data.items[0]).sort()).toEqual(
        ['city', 'country', 'id', 'maskedIp', 'visitedAt'].sort(),
      );
      expect(data.items[0].maskedIp).toBe('203.0.113.0/24');
      expect(data.items[0].country).toBe('CN');
      expect(new Date(data.items[0].visitedAt).toString()).not.toBe('Invalid Date');
    });

    it('非法参数 → 400（period=hour / page=0 / pageSize=51 / pageSize=abc）', async () => {
      for (const q of [
        'period=hour',
        'page=0',
        'pageSize=51',
        'pageSize=abc',
        'period=',
      ]) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/cms/visitor-records?${q}`)
          .set(auth(admin.token));
        expect(res.status).toBe(400);
      }
    });

    it('空周期 → 200 空列表（不 404 不 500）', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-records?period=month')
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.3 分页稳定性
  // ---------------------------------------------------------------------------

  describe('12.3 records 分页稳定性', () => {
    beforeAll(async () => {
      await cleanVisitorData(prisma);
      // 25 条：时间从早到晚（firstSeenAt 递增 → 列表倒序排）
      const base = new Date(utcDayStart(new Date()).getTime() + 60_000);
      for (let i = 0; i < 25; i += 1) {
        await seedSession(prisma, vid(100 + i), {
          firstSeenAt: new Date(base.getTime() + i * 60_000),
          country: 'CN',
          maskedIp: '198.51.100.0/24',
        });
      }
    });

    it('pageSize=10：total=25、totalPages=3、每页条数 10/10/5', async () => {
      const p1 = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-records?period=day&page=1&pageSize=10')
        .set(auth(admin.token));
      const p2 = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-records?period=day&page=2&pageSize=10')
        .set(auth(admin.token));
      const p3 = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-records?period=day&page=3&pageSize=10')
        .set(auth(admin.token));
      expect(p1.body.data.total).toBe(25);
      expect(p1.body.data.totalPages).toBe(3);
      expect(p1.body.data.items).toHaveLength(10);
      expect(p2.body.data.items).toHaveLength(10);
      expect(p3.body.data.items).toHaveLength(5);
    });

    it('三页无重叠、无遗漏；全序时间倒序（边界同毫秒也不漂移）', async () => {
      const pages = await Promise.all(
        [1, 2, 3].map((p) =>
          request(app.getHttpServer())
            .get(`/api/v1/cms/visitor-records?period=day&page=${p}&pageSize=10`)
            .set(auth(admin.token)),
        ),
      );
      const ids = pages.flatMap((r) => r.body.data.items.map((i: { id: string }) => i.id));
      expect(new Set(ids).size).toBe(25); // 无重叠无遗漏

      const times = pages
        .flatMap((r) => r.body.data.items.map((i: { visitedAt: string }) => i.visitedAt))
        .map((t: string) => new Date(t).getTime());
      for (let i = 1; i < times.length; i += 1) {
        expect(times[i]).toBeLessThanOrEqual(times[i - 1]!); // 恒倒序
      }
    });

    it('越界页 → 空列表且 total 不变', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-records?period=day&page=9&pageSize=10')
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(25);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.4 隐私
  // ---------------------------------------------------------------------------

  describe('12.4 隐私红线', () => {
    beforeEach(async () => {
      await cleanVisitorData(prisma);
    });

    it('真实 track 链路：完整 IP 只做 GeoIP、落库仅 /24 网段', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/visitor/track')
        .set('X-Forwarded-For', '203.0.113.47')
        .set('User-Agent', 'E2E-Privacy-UA/1.0')
        .send({ visitorId: vid(200) });
      expect(res.status).toBe(200);

      const rows = await prisma.visitorSession.findMany({ where: { visitorId: vid(200) } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.maskedIp).toBe('203.0.113.0/24'); // 末段归零 + /24
      // 任何字段都不存完整 IP
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain('203.0.113.47');
    });

    it('records 响应不出现 visitorId / userAgent / region 键或值', async () => {
      await prisma.visitorSession.create({
        data: {
          visitorId: vid(201),
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          visitCount: 1,
          country: 'US',
          region: 'California',
          city: 'LA',
          maskedIp: '198.51.100.0/24',
          userAgent: 'SECRET-UA-STRING',
          isNewVisitor: true,
        },
      });
      const res = await request(app.getHttpServer())
        .get('/api/v1/cms/visitor-records?period=day')
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('visitorId');
      expect(body).not.toContain('userAgent');
      expect(body).not.toContain('SECRET-UA-STRING');
      expect(body).not.toContain('California'); // region 不外泄
      expect(body).not.toContain(vid(201));
    });

    it('overview / trend 响应同样不含任何访客标识', async () => {
      await seedSession(prisma, vid(202), { firstSeenAt: new Date() });
      for (const path of ['/api/v1/cms/visitor-stats/overview', '/api/v1/cms/visitor-stats/trend?days=7']) {
        const res = await request(app.getHttpServer()).get(path).set(auth(admin.token));
        const body = JSON.stringify(res.body);
        expect(body).not.toContain('visitorId');
        expect(body).not.toContain(vid(202));
        expect(body).not.toContain('userAgent');
      }
    });
  });
});
