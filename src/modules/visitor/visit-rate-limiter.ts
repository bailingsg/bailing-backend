/**
 * 上报限流器（访客统计实现规格 4.4）。
 *
 * 固定窗口计数，进程内 Map + 惰性清扫（每 60 秒顺带清理过期桶）。
 *
 *   · 单访客  visitor:<uuid>   120 次 / 60 秒
 *   · 单网段  ip:<maskedIp>   1200 次 / 60 秒
 *
 * 三条红线：
 *   1. 超限**不返回 429**，由调用方静默丢弃——429 对刷量脚本是阈值探测信号；
 *   2. 限流 key 含 IP 网段，**不得写进日志**（本类无任何日志调用）；
 *   3. 多实例部署时各实例独立计数，可接受（目的是挡明显刷量，不是精确配额）。
 */

interface Bucket {
  count: number;
  /** 窗口起点（ms） */
  windowStart: number;
}

/** 窗口长度 60 秒；清扫动作也按该间隔触发 */
const WINDOW_MS = 60_000;

/** 单访客窗口上限 */
const VISITOR_LIMIT = 120;

/** 单网段窗口上限 */
const IP_LIMIT = 1200;

/** 惰性清扫间隔（顺带做，不单独占定时器） */
const SWEEP_INTERVAL_MS = 60_000;

export class VisitRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepAt = 0;

  /**
   * 尝试消费一次配额。任一维度超限即返回 false（调用方静默丢弃）。
   */
  tryConsume(visitorId: string, maskedIp: string | null, now: number): boolean {
    this.maybeSweep(now);
    if (!this.consumeOne(`visitor:${visitorId}`, VISITOR_LIMIT, now)) {
      return false;
    }
    if (maskedIp && !this.consumeOne(`ip:${maskedIp}`, IP_LIMIT, now)) {
      return false;
    }
    return true;
  }

  /** 仅供测试：清空全部桶 */
  reset(): void {
    this.buckets.clear();
    this.lastSweepAt = 0;
  }

  private consumeOne(key: string, limit: number, now: number): boolean {
    const current = this.buckets.get(key);
    if (!current || now - current.windowStart >= WINDOW_MS) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (current.count >= limit) {
      return false;
    }
    current.count += 1;
    return true;
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= WINDOW_MS) {
        this.buckets.delete(key);
      }
    }
  }
}
