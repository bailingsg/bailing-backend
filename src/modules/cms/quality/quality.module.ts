import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { QualityRecordsController } from './quality-records.controller';
import { QualityRecordsService } from './quality-records.service';

/**
 * 质量体系 CMS 模块（Phase 4.5）。
 * 全部接口经控制器级 JwtAuthGuard 保护。
 */
@Module({
  imports: [PrismaModule],
  controllers: [QualityRecordsController],
  providers: [QualityRecordsService],
  exports: [QualityRecordsService],
})
export class QualityModule {}
