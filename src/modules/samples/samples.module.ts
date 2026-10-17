import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { SamplesController } from './samples.controller';
import { SamplesService } from './samples.service';

/**
 * 样品管理模块（Phase 5.1）。
 *
 * RbacModule 提供权限解析（RbacService）与审计（AuditLogService）。
 */
@Module({
  imports: [RbacModule],
  controllers: [SamplesController],
  providers: [SamplesService],
  exports: [SamplesService],
})
export class SamplesModule {}
