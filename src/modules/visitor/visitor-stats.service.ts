import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  SESSION_TIMEOUT_MINUTES,
  periodWindow,
  utcDayStart,
  utcNextDayStart,
  type VisitorRecordPeriod,
} from './session-window';

/**
 * 访客统计读取（访客统计实现规格第 5 节：概览与趋势）。
 *
 * 两条不可违背的取数规则：
 *   1. **今日永远实时查事实源**，不读读模型——日聚合按小时跑，
 *      读模型滞后，把滞后当事实会让「刚刚到访」显示成 0；
 *   2. 历史日优先读读模型（快），读模型缺失（聚合未跑到 / 新环境
 *      首次启动）⇒ 回退实时聚合，且回退算出的必须是真实数据，
 *      不插值、不补假点。
 *
 * UV 一律 COUNT(DISTINCT visitor_id) 语义：绝不允许逐日 UV 相加
 * （同一访客跨天会被重复计，数字持续虚高且不报错）。
 */

/** 统计口径说明（随每个响应返回，前端如实展示） */
export const VISITOR_SCOPE_NOTE =
  '匿名流量统计，与登录账号 / 客户档案 / 订单无任何关联，不用于业务判定。';

/** 响应里的 scope 字段（时区 UTC 必须在界面标注） */
export function visitorScope() {
  return {
    timezone: 'UTC' as const,
    sessionTimeoutMinutes: SESSION_TIMEOUT_MINUTES,
    note: VISITOR_SCOPE_NOTE,
  };
}

/** 单日统计点 */
export interface DayPoint {
  date: string; // YYYY-MM-DD（UTC）
  uniqueVisitors: number;
  visits: number;
  newVisitors: number;
}

/** 区间统计 */
export interface RangeSummary {
  uniqueVisitors: number;
  visits: number;
}

@Injectable()
export class VisitorStatsService {
  private readonly logger = new Logger(VisitorStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** GET overview：今日实时 + last7Days / last30Days 区间去重（规格 5.1） */
  async overview(now: Date = new Date()) {
    const todayStart = utcDayStart(now);
    const tomorrowStart = utcNextDayStart(now);

    const today = await this.liveDayPoint(todayStart, tomorrowStart);
    const last7Days = await this.rangeSummary(
      new Date(todayStart.getTime() - 6 * 86_400_000),
      tomorrowStart,
    );
    const last30Days = await this.rangeSummary(
      new Date(todayStart.getTime() - 29 * 86_400_000),
      tomorrowStart,
    );

    return {
      scope: visitorScope(),
      // liveDayPoint 已含 date 字段（规格 5.1 的 today.date）
      today,
      last7Days: { days: 7, ...last7Days },
      last30Days: { days: 30, ...last30Days },
      generatedAt: now.toISOString(),
    };
  }

  /**
   * GET trend（规格 5.2）：
   *   · points 按日期升序，长度恒等于 days，末项恒为今日；
   *   · 缺失日期补 0（不跳号，否则折线图 X 轴压缩、视觉谎报趋势）；
   *   · 今日恒实时；历史日读读模型，缺失回退实时。
   */
  async trend(days: 7 | 30, now: Date = new Date()) {
    const todayStart = utcDayStart(now);
    const tomorrowStart = utcNextDayStart(now);
    const rangeStart = new Date(todayStart.getTime() - (days - 1) * 86_400_000);

    // 读模型：区间内已聚合的日期（statDate 只可能落在 rangeStart..今日）
    const stored = await this.prisma.visitorDailyStatistic.findMany({
      where: { statDate: { gte: rangeStart, lt: tomorrowStart } },
    });
    const storedByDate = new Map(stored.map((row) => [isoDate(row.statDate), row]));

    const points: DayPoint[] = [];
    for (let offset = 0; offset < days; offset += 1) {
      const dayStart = new Date(rangeStart.getTime() + offset * 86_400_000);
      const date = isoDate(dayStart);
      const storedRow = storedByDate.get(date);
      const isToday = offset === days - 1;
      if (storedRow && !isToday) {
        points.push({
          date,
          uniqueVisitors: storedRow.uniqueVisitors,
          visits: storedRow.visits,
          newVisitors: storedRow.newVisitors,
        });
        continue;
      }
      // 今日恒实时；历史日读模型缺失 ⇒ 回退实时聚合（真实数据）
      // liveDayPoint 已含正确的 date 字段
      const live = await this.liveDayPoint(dayStart, utcNextDayStart(dayStart));
      points.push(live);
    }

    return { days, scope: visitorScope(), points, generatedAt: now.toISOString() };
  }

  /** 单日实时点（事实源，规格 5.3：groupBy 求 UV、sum 求 PV） */
  async liveDayPoint(dayStart: Date, nextDayStart: Date): Promise<DayPoint> {
    const [uvGroups, pvAgg, newVisitors] = await Promise.all([
      this.prisma.visitorSession.groupBy({
        by: ['visitorId'],
        where: { firstSeenAt: { gte: dayStart, lt: nextDayStart } },
      }),
      this.prisma.visitorSession.aggregate({
        _sum: { visitCount: true },
        where: { firstSeenAt: { gte: dayStart, lt: nextDayStart } },
      }),
      this.prisma.visitorSession.count({
        where: { firstSeenAt: { gte: dayStart, lt: nextDayStart }, isNewVisitor: true },
      }),
    ]);
    return {
      date: isoDate(dayStart),
      uniqueVisitors: uvGroups.length,
      visits: pvAgg._sum.visitCount ?? 0,
      newVisitors,
    };
  }

  /** 区间汇总：UV 去重（不是逐日相加）+ PV 求和 */
  private async rangeSummary(gte: Date, lt: Date): Promise<RangeSummary> {
    const [uvGroups, pvAgg] = await Promise.all([
      this.prisma.visitorSession.groupBy({
        by: ['visitorId'],
        where: { firstSeenAt: { gte, lt } },
      }),
      this.prisma.visitorSession.aggregate({
        _sum: { visitCount: true },
        where: { firstSeenAt: { gte, lt } },
      }),
    ]);
    return { uniqueVisitors: uvGroups.length, visits: pvAgg._sum.visitCount ?? 0 };
  }

  /** 供聚合 worker 复用：算某日并 UPSERT 读模型（幂等，规格 5.4） */
  async aggregateDay(dayStart: Date): Promise<DayPoint> {
    const point = await this.liveDayPoint(dayStart, utcNextDayStart(dayStart));
    await this.prisma.visitorDailyStatistic.upsert({
      where: { statDate: dayStart },
      create: {
        statDate: dayStart,
        uniqueVisitors: point.uniqueVisitors,
        visits: point.visits,
        newVisitors: point.newVisitors,
        computedAt: new Date(),
      },
      update: {
        uniqueVisitors: point.uniqueVisitors,
        visits: point.visits,
        newVisitors: point.newVisitors,
        computedAt: new Date(),
      },
    });
    return point;
  }

  /**
   * GET records（规格 6.4）：会话级明细。
   *
   * 三条硬约束：
   *   1. 第二排序键 id 不可省（同毫秒多条记录时分页边界不漂移）；
   *   2. 分页由数据库 LIMIT/OFFSET 完成，不先全量取出再切片；
   *   3. 显式 select 白名单——visitorId / userAgent / region 根本不进内存，
   *      从查询层保证不外泄，不是「查出来再删字段」。
   */
  async records(params: {
    period: VisitorRecordPeriod;
    page: number;
    pageSize: number;
    now?: Date;
  }) {
    const now = params.now ?? new Date();
    const { gte, lte } = periodWindow(params.period, now);

    const [rows, total] = await Promise.all([
      this.prisma.visitorSession.findMany({
        where: { firstSeenAt: { gte, lte } },
        orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          maskedIp: true,
          country: true,
          city: true,
          firstSeenAt: true,
        },
      }),
      this.prisma.visitorSession.count({ where: { firstSeenAt: { gte, lte } } }),
    ]);

    return {
      scope: visitorScope(),
      period: params.period,
      items: rows.map((row) => ({
        id: row.id,
        maskedIp: row.maskedIp,
        country: row.country,
        city: row.city,
        visitedAt: row.firstSeenAt.toISOString(),
      })),
      page: params.page,
      pageSize: params.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
      generatedAt: now.toISOString(),
    };
  }
}

/** Date → YYYY-MM-DD（UTC） */
export function isoDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
