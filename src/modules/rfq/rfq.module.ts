import { Module } from '@nestjs/common';
import { RfqController } from './rfq.controller';
import { RfqService } from './rfq.service';
import { LeadDistributionModule } from '../cms/lead-distribution/lead-distribution.module';

/**
 * RFQ 询盘模块。
 *
 * Phase 4.6：导入 LeadDistributionModule，使 RfqService 能在创建询盘的同一事务内
 * 自动分配承接人（倾斜计划 / 正常轮询）。公开提交接口与后台 X-Admin-Token 接口的
 * 认证方式均不变，分配失败不影响询盘入库。
 */
@Module({
  imports: [LeadDistributionModule],
  controllers: [RfqController],
  providers: [RfqService],
  exports: [RfqService],
})
export class RfqModule {}
