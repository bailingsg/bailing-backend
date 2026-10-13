import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** GET /api/v1/health —— 存活检查，不依赖数据库 */
  @Get()
  liveness() {
    return this.healthService.liveness();
  }

  /** GET /api/v1/health/ready —— 就绪检查，含数据库连接状态，未就绪返回 503 */
  @Get('ready')
  ready() {
    return this.healthService.assertReady();
  }
}
