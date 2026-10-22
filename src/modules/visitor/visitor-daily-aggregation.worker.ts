import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VisitorStatsService } from './visitor-stats.service';
import { utcDayStart } from './session-window';

/**
 * 访客日聚合 worker（访客统计实现规格 5.4）。
 *
 * 设计要点：
 *   · 每小时一轮（下限 60 秒），**幂等 UPSERT**（statDate 唯一键覆盖）；
 *   · 每轮重算**今日 + 昨日**，不是只算昨日：跨天会话与迟到上报让
 *     今日数据持续变化，昨日最后一批「昨日开始」的会话也可能 00:00 后才落库；
 *   · 防重入：running 布尔闸门跳过重叠轮次；
 *   · 失败隔离：整轮 try/catch，异常只记日志，绝不外抛；
 *   · unref()：定时器不阻塞进程退出；
 *   · NODE_ENV=test 或 VISITOR_AGGREGATION_ENABLED=false 时关闭；
 *   · 🔴 不引入 cron / MQ / Redis / @nestjs/schedule。
 */
@Injectable()
export class VisitorDailyAggregationWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(VisitorDailyAggregationWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly stats: VisitorStatsService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>('visitorAggregationEnabled')) {
      this.logger.log('日聚合 worker 已关闭（VISITOR_AGGREGATION_ENABLED=false）');
      return;
    }
    // 每小时一轮；unref 不阻塞退出
    this.timer = setInterval(() => void this.runOnce(), 60 * 60_000);
    this.timer.unref();
    this.logger.log('日聚合 worker 已启动（每 60 分钟重算今日 + 昨日）');
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 执行一轮（供定时器与测试调用） */
  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.running) return; // 防重入
    this.running = true;
    try {
      const todayStart = utcDayStart(now);
      for (const offset of [0, 1]) {
        const dayStart = new Date(todayStart.getTime() - offset * 86_400_000);
        const point = await this.stats.aggregateDay(dayStart);
        // 日志只允许聚合统计量，不得出现 IP / visitorId / UA
        this.logger.log(
          `日聚合完成 date=${point.date} uv=${point.uniqueVisitors} pv=${point.visits} new=${point.newVisitors}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `日聚合本轮失败（已跳过，下轮重试）：${error instanceof Error ? error.name : 'unknown'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
