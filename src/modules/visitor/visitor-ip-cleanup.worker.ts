import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** 启动后首轮延迟（ms）：避开启动期初始化与迁移竞争 */
const INITIAL_DELAY_MS = 2 * 60_000;

/** 清扫间隔（ms）：6 小时。保留期以天计，没必要更频繁 */
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/** 保留期兜底值（配置层已归一化，这里只防 undefined） */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * 访客 IP 明细清理 worker（「近期访客 IP」功能，2026-10-27）。
 *
 * 为什么必须存在：`visitor_ip_log` 存的是**完整 IP 原文**，属个人信息。
 * 没有自动删除的 IP 表在合规上是硬伤——「我们只保留 30 天」这句话必须有
 * 代码兑现，不能靠人记得手动删。
 *
 * 设计沿用 VisitorDailyAggregationWorker 的写法（项目统一约定）：
 *   · setInterval + unref()，定时器不阻塞进程退出；
 *   · 防重入：running 布尔闸门跳过重叠轮次；
 *   · 失败隔离：整轮 try/catch，异常只记日志，绝不外抛；
 *   · NODE_ENV=test 或 VISITOR_IP_CLEANUP_ENABLED=false 时关闭；
 *   · 🔴 不引入 cron / MQ / Redis / @nestjs/schedule。
 *
 * 保留期取 `VISITOR_IP_RETENTION_DAYS`（默认 30，非法值回退 30）。
 */
@Injectable()
export class VisitorIpCleanupWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(VisitorIpCleanupWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>('visitorIpCleanupEnabled')) {
      this.logger.log('访客 IP 明细清理 worker 已关闭（VISITOR_IP_CLEANUP_ENABLED=false）');
      return;
    }

    // 启动后 2 分钟先跑一轮（避开启动期初始化与迁移竞争），之后每 6 小时一轮
    this.initialTimer = setTimeout(() => void this.runOnce(), INITIAL_DELAY_MS);
    this.initialTimer.unref();
    this.timer = setInterval(() => void this.runOnce(), SWEEP_INTERVAL_MS);
    this.timer.unref();

    this.logger.log(
      `访客 IP 明细清理 worker 已启动（保留 ${this.retentionDays()} 天，每 6 小时一轮）`,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  /** 保留天数（配置层已归一化，这里只做兜底） */
  private retentionDays(): number {
    const raw = this.config.get<number>('visitorIpRetentionDays');
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
      ? raw
      : DEFAULT_RETENTION_DAYS;
  }

  /** 执行一轮清理（供定时器与测试调用） */
  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.running) return; // 防重入
    this.running = true;
    try {
      const days = this.retentionDays();
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      const { count } = await this.prisma.visitorIpLog.deleteMany({
        where: { visitedAt: { lt: cutoff } },
      });
      // 日志只允许聚合量（删除行数），不得出现任何 IP（规格 10.4）
      if (count > 0) {
        this.logger.log(`访客 IP 明细清理完成：删除 ${count} 条（保留 ${days} 天）`);
      }
    } catch (error) {
      this.logger.warn(
        `访客 IP 明细清理失败（已跳过本轮）：${error instanceof Error ? error.name : 'unknown'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
