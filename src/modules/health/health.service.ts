import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LivenessResult {
  status: 'ok';
  uptime: number;
  timestamp: string;
}

export interface ReadinessResult {
  status: 'ready' | 'degraded';
  checks: {
    database: boolean;
  };
  timestamp: string;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  /** 服务存活状态：不依赖数据库，任何情况下都应响应 */
  liveness(): LivenessResult {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** 就绪状态：包含数据库连接检查 */
  async readiness(): Promise<ReadinessResult> {
    const database = await this.prisma.isHealthy();
    return {
      status: database ? 'ready' : 'degraded',
      checks: { database },
      timestamp: new Date().toISOString(),
    };
  }

  /** 就绪检查的守卫版本：数据库不可用时抛出 503 */
  async assertReady(): Promise<ReadinessResult> {
    const result = await this.readiness();
    if (!result.checks.database) {
      throw new ServiceUnavailableException('Database is not ready');
    }
    return result;
  }
}
