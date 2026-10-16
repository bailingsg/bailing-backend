import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { LeadDistributionController } from './lead-distribution.controller';
import { LeadDistributionService } from './lead-distribution.service';

/**
 * 询盘分配模块（Phase 4.6）。
 *
 * 导出 LeadDistributionService 供 RFQ 模块在创建询盘时自动分配承接人
 * （同一事务内完成，保证「询盘 + 分配 + 指针推进」原子）。
 *
 * AuditLogService 由 @Global 的 RbacModule 提供，无需在此重复导入。
 */
@Module({
  imports: [PrismaModule],
  controllers: [LeadDistributionController],
  providers: [LeadDistributionService],
  exports: [LeadDistributionService],
})
export class LeadDistributionModule {}
