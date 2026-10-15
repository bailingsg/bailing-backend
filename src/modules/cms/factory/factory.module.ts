import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { FactorySectionsController } from './factory-sections.controller';
import { FactorySectionsService } from './factory-sections.service';

/** 工厂实力 CMS 模块（Phase 4.5）。控制器挂 JwtAuthGuard：全部接口要求登录。 */
@Module({
  imports: [PrismaModule],
  controllers: [FactorySectionsController],
  providers: [FactorySectionsService],
  exports: [FactorySectionsService],
})
export class FactoryModule {}
