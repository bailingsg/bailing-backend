import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 服务。
 * 采用惰性连接策略：应用启动时不强制连接数据库，
 * 保证数据库暂时不可用时 /api/v1/health 仍能响应；
 * 首次查询时由 Prisma Client 自动建连。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * 数据库连接健康检查（用于 readiness）。
   * 内部捕获异常，不向调用方暴露连接细节。
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
