import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

/**
 * 产品应用场景 CMS 模块（Phase 4.5）。
 * 全部接口经控制器级 JwtAuthGuard 保护。
 */
@Module({
  imports: [PrismaModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
