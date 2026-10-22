/**
 * 会话窗口 / 统计日界 / 明细查询周期（访客统计实现规格 2.2 / 2.6 / 6.3）。
 *
 * 三条硬约束：
 *   1. 会话窗口 30 分钟：距上次活动 ≤ 30min 判「延续」，> 30min 新建会话；
 *   2. 时钟回拨（elapsed 为负）按「延续」处理——NTP 校正不应凭空多出会话；
 *   3. 统计日统一 UTC 日界（00:00:00.000Z 起），跨天会话整条计入开始日。
 */

/** 会话窗口（分钟）。规格 2.2：30 分钟无活动视为新会话。 */
export const SESSION_TIMEOUT_MINUTES = 30;

/** 会话窗口（毫秒） */
export const SESSION_TIMEOUT_MS = SESSION_TIMEOUT_MINUTES * 60_000;

/**
 * 判断一次上报是否延续上次会话。
 *
 * @param lastSeenAt 该 visitorId 最近一条会话的最后活动时间
 * @param now        当前时间
 * @returns elapsed ≤ 会话窗口 即延续（含时钟回拨的负 elapsed）
 */
export function isSessionContinued(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() <= SESSION_TIMEOUT_MS;
}

/** UTC 当日零点（统计日归属的唯一入口，规格 2.6/2.7）。 */
export function utcDayStart(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
}

/** UTC 次日零点。 */
export function utcNextDayStart(instant: Date): Date {
  const start = utcDayStart(instant);
  return new Date(start.getTime() + 86_400_000);
}

/** 查询周期（规格 6.2）。 */
export type VisitorRecordPeriod = 'day' | 'week' | 'month';

/** 明细查询时间窗（UTC，闭区间）。 */
export interface PeriodWindow {
  gte: Date;
  lte: Date;
}

/**
 * 周期时间窗（规格 6.3）：
 *   · day   当日 00:00:00.000 ~ 当日 23:59:59.999（用 now 会让同一天不同
 *           时刻查询结果不同，任务语义是「整天」）
 *   · week  本周一 00:00:00.000 ~ 当前时刻（ISO 周，周一为一周之首）
 *   · month 本月 1 日 00:00:00.000 ~ 当前时刻
 */
export function periodWindow(period: VisitorRecordPeriod, now: Date): PeriodWindow {
  if (period === 'day') {
    return { gte: utcDayStart(now), lte: new Date(utcNextDayStart(now).getTime() - 1) };
  }
  if (period === 'week') {
    // getUTCDay(): 0=周日 … 6=周六；周一为周首 ⇒ 回退 (day+6)%7 天
    const dayStart = utcDayStart(now);
    const offsetDays = (now.getUTCDay() + 6) % 7;
    return { gte: new Date(dayStart.getTime() - offsetDays * 86_400_000), lte: now };
  }
  // month
  return {
    gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    lte: now,
  };
}
