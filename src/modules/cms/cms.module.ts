import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CmsController } from './cms.controller';
import { CmsService } from './cms.service';

/**
 * CMS 模块（Phase 4.1 起步）。
 * 控制器级挂 JwtAuthGuard：本模块所有接口默认要求登录。
 */
@Module({
  imports: [PrismaModule],
  controllers: [CmsController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule {}
