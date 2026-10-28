import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { VisitorModule } from '../src/modules/visitor/visitor.module';
import { VisitorService } from '../src/modules/visitor/visitor.service';
import { GeoIpResolver } from '../src/modules/visitor/geoip/geoip.resolver';
import { utcDayStart, utcNextDayStart } from '../src/modules/visitor/session-window';
import configuration from '../src/config/configuration';
import { setupApp } from '../src/app.setup';
import request from 'supertest';

/**
 * 访客统计 M1：口径正确性验收（实现规格 12.1 八条 + track 契约 9/10/11/12）。
 *
 * 依赖本地 Docker PostgreSQL（visitor_session / visitor_daily_statistic 表已迁移）。
 * 全部用例使用 `00000000-0000-4000-8000-0000000000NN` 段 UUID，afterAll 清理。
 */

/** 测试专用 visitorId（合法 v4） */
const vid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * 清空访客会话表（e2e 库专用，全表安全；测试夹具与非测试杂质一并清除）。
 */
async function cleanSessions(prisma: PrismaService): Promise<void> {
  await prisma.visitorSession.deleteMany({});
}

/** 直接取某 visitorId 的会话行（测试断言用） */
async function rowsOf(prisma: PrismaService, visitorId: string) {
  return prisma.visitorSession.findMany({
    where: { visitorId },
    orderBy: { firstSeenAt: 'asc' },
  });
}

/** 区间 UV（COUNT(DISTINCT visitorId) 的等价实现，规格 5.3） */
async function rangeUv(prisma: PrismaService, gte: Date, lt: Date, visitorId?: string): Promise<number> {
  const groups = await prisma.visitorSession.groupBy({
    by: ['visitorId'],
    where: { firstSeenAt: { gte, lt }, ...(visitorId ? { visitorId } : {}) },
  });
  return groups.length;
}

/** 区间 PV（SUM(visitCount)，规格 2.4） */
async function rangePv(prisma: PrismaService, gte: Date, lt: Date, visitorId?: string): Promise<number> {
  const agg = await prisma.visitorSession.aggregate({
    _sum: { visitCount: true },
    where: { firstSeenAt: { gte, lt }, ...(visitorId ? { visitorId } : {}) },
  });
  return agg._sum.visitCount ?? 0;
}

/** 造一条历史会话（测试夹具） */
async function seedSession(
  prisma: PrismaService,
  visitorId: string,
  opts: { firstSeenAt: Date; lastSeenAt: Date; country?: string },
): Promise<void> {
  await prisma.visitorSession.create({
    data: {
      visitorId,
      firstSeenAt: opts.firstSeenAt,
      lastSeenAt: opts.lastSeenAt,
      visitCount: 1,
      country: opts.country ?? null,
      isNewVisitor: false,
    },
  });
}

/** 通过 HTTP 上报一次（与前端真实链路一致） */
async function track(httpServer: Parameters<typeof request>[0] extends never ? never : any, visitorId: string) {
  return request(httpServer)
    .post('/api/v1/visitor/track')
    .set('X-Forwarded-For', '203.0.113.47')
    .send({ visitorId });
}

describe('访客统计 M1（口径 12.1 + track 契约）', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] }), VisitorModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // 与生产一致的管道（全局前缀 / ValidationPipe / TransformInterceptor）
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    await cleanSessions(prisma);
  });

  afterAll(async () => {
    await cleanSessions(prisma);
    await app.close();
  });

  beforeEach(async () => {
    // 用例间隔离：聚合类断言只统计本用例造的数据
    await cleanSessions(prisma);
  });

  it('用例 1：同一 visitorId 连续上报 3 次（间隔 1 秒）→ 会话 1 行，visit_count=3，UV=1，PV=3', async () => {
    const id = vid(1);
    for (let i = 0; i < 3; i += 1) {
      const res = await track(app.getHttpServer(), id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true }); // 用例 11：只有这一个键
      if (i < 2) await new Promise((r) => setTimeout(r, 1000));
    }
    const rows = await rowsOf(prisma, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.visitCount).toBe(3);

    const today = utcDayStart(new Date());
    const tomorrow = utcNextDayStart(new Date());
    expect(await rangeUv(prisma, today, tomorrow)).toBe(1);
    expect(await rangePv(prisma, today, tomorrow)).toBe(3);
  });

  it('用例 2：上报 1 次后间隔 31 分钟再上报 → 会话 2 行，第 2 行 is_new_visitor=false，UV=1，PV=2', async () => {
    const id = vid(2);
    await track(app.getHttpServer(), id);
    // 把已有会话的最后活动时间拨回 31 分钟前（等价于等待 31 分钟）
    await prisma.visitorSession.updateMany({
      where: { visitorId: id },
      data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) },
    });
    await track(app.getHttpServer(), id);

    const rows = await rowsOf(prisma, id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.isNewVisitor).toBe(false);

    const today = utcDayStart(new Date());
    const tomorrow = utcNextDayStart(new Date());
    expect(await rangeUv(prisma, today, tomorrow)).toBe(1);
    expect(await rangePv(prisma, today, tomorrow)).toBe(2);
  });

  it('用例 3：两个 visitorId 各上报 1 次 → UV=2，PV=2', async () => {
    await track(app.getHttpServer(), vid(30));
    await track(app.getHttpServer(), vid(31));

    const today = utcDayStart(new Date());
    const tomorrow = utcNextDayStart(new Date());
    expect(await rangeUv(prisma, today, tomorrow)).toBe(2);
    expect(await rangePv(prisma, today, tomorrow)).toBe(2);
  });

  it('用例 4：同一 visitorId 连续 3 天各 1 次，查 7 日区间 → 区间 UV=1（不是 3）', async () => {
    const id = vid(4);
    const now = new Date();
    for (const offset of [2, 1, 0]) {
      const day = new Date(utcDayStart(now).getTime() - offset * 86_400_000);
      await seedSession(prisma, id, {
        firstSeenAt: new Date(day.getTime() + 12 * 3_600_000),
        lastSeenAt: new Date(day.getTime() + 12 * 3_600_000),
      });
    }
    const gte = new Date(utcDayStart(now).getTime() - 6 * 86_400_000);
    const lt = utcNextDayStart(now);
    expect(await rangeUv(prisma, gte, lt)).toBe(1);
    expect(await rangePv(prisma, gte, lt)).toBe(3);
  });

  it('用例 5a：23:55 会话 + 次日 00:05 延续 → 仍 1 行且归属前一天，次日该访客 UV=0', async () => {
    const id = vid(5);
    const now = new Date();
    // 昨天 23:55 = 今天 UTC 零点 − 5 分钟
    const yesterday2355 = new Date(utcDayStart(now).getTime() - 5 * 60_000);
    // 会话开始于昨日 23:55，最后活动仍在 30 分钟窗口内（模拟次日 00:05 延续）
    await seedSession(prisma, id, {
      firstSeenAt: yesterday2355,
      lastSeenAt: new Date(Date.now() - 60_000),
    });
    await track(app.getHttpServer(), id); // 触发延续更新

    const rows = await rowsOf(prisma, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstSeenAt.getTime()).toBe(yesterday2355.getTime()); // 归属不变
    // first_seen_at 仍是昨天 ⇒ 今日区间 UV = 0（整条计入开始日）
    const today = utcDayStart(now);
    expect(await rangeUv(prisma, today, utcNextDayStart(now))).toBe(0);
  });

  it('用例 5b：23:55 会话 + 40 分钟后新建 → 2 行分别归属两天，各计 1 次访问', async () => {
    const id = vid(6);
    const now = new Date();
    // 昨天 23:55 = 今天 UTC 零点 − 5 分钟
    const yesterday2355 = new Date(utcDayStart(now).getTime() - 5 * 60_000);
    // 会话开始于昨日 23:55，最后活动已超出 30 分钟窗口
    await seedSession(prisma, id, {
      firstSeenAt: yesterday2355,
      lastSeenAt: new Date(yesterday2355.getTime() + 40 * 60_000),
    });
    await track(app.getHttpServer(), id); // 超出窗口 ⇒ 新建会话（归属今天）

    const rows = await rowsOf(prisma, id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.firstSeenAt.getTime()).toBe(yesterday2355.getTime());
    expect(rows[1]!.firstSeenAt.getTime()).toBeGreaterThan(utcDayStart(now).getTime());

    const todayStart = utcDayStart(now);
    const tomorrowStart = utcNextDayStart(now);
    const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
    // 昨日区间（含昨天 23:55 开始的那条）与今日区间各 1 次访问
    expect(await rangeUv(prisma, yesterdayStart, todayStart)).toBe(1);
    expect(await rangePv(prisma, yesterdayStart, todayStart)).toBe(1);
    expect(await rangeUv(prisma, todayStart, tomorrowStart)).toBe(1);
    expect(await rangePv(prisma, todayStart, tomorrowStart)).toBe(1);
  });

  it('用例 6：全新 visitorId 首次上报 → is_new_visitor=true', async () => {
    const id = vid(7);
    await track(app.getHttpServer(), id);
    const rows = await rowsOf(prisma, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isNewVisitor).toBe(true);
  });

  it('用例 7：时钟回拨（lastSeenAt 在未来）→ 判为延续，不新建会话', async () => {
    const id = vid(8);
    await track(app.getHttpServer(), id);
    // 把最后活动时间拨到未来 5 分钟（NTP 校正场景）
    await prisma.visitorSession.updateMany({
      where: { visitorId: id },
      data: { lastSeenAt: new Date(Date.now() + 5 * 60_000) },
    });
    await track(app.getHttpServer(), id);

    const rows = await rowsOf(prisma, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.visitCount).toBe(2);
  });

  it('用例 8：会话内第二次上报的 GeoIP 结果不同 → country 不变（只补空缺）', async () => {
    const id = vid(9);
    let call = 0;
    // VisitorDailyAggregationWorker（M2 起）依赖 ConfigService，局部模块需显式提供
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] }), VisitorModule],
    })
      .overrideProvider(GeoIpResolver)
      .useValue({
        // 第一次 CN，第二次 US —— 第二次不应覆盖
        resolve: () => {
          call += 1;
          return call === 1
            ? { country: 'CN', region: null, city: '杭州' }
            : { country: 'US', region: null, city: '纽约' };
        },
      })
      .compile();
    const svc = moduleRef.get(VisitorService);
    const db = moduleRef.get(PrismaService);

    await svc.track(id, '203.0.113.47', 'E2E-UA/1.0');
    await svc.track(id, '198.51.100.9', 'E2E-UA/1.0');

    const rows = await db.visitorSession.findMany({ where: { visitorId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.country).toBe('CN'); // 不被覆盖
    expect(rows[0]!.visitCount).toBe(2);
    await moduleRef.close();
  });

  it('契约 9：传非 UUID visitorId → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/visitor/track')
      .send({ visitorId: 'abc' });
    expect(res.status).toBe(400);
  });

  it('契约 10：多传 userId 字段 → 400（未声明字段被拒）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/visitor/track')
      .send({ visitorId: vid(10), userId: 'x' });
    expect(res.status).toBe(400);
  });

  it('契约 12：数据库不可用时仍 200 {success:true}（失败静默）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] }), VisitorModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        visitorSession: {
          findFirst: () => Promise.reject(new Error('db down')),
        },
      })
      .compile();
    const svc = moduleRef.get(VisitorService);
    // 不抛错即达成「静默」；响应由控制器恒返回
    await expect(svc.track(vid(12), '203.0.113.47', null)).resolves.toBeUndefined();
    await moduleRef.close();
  });
});
