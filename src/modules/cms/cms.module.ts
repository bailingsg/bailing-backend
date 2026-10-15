import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CmsController } from './cms.controller';
import { CmsService } from './cms.service';
import { ProductsModule } from './products/products.module';
import { BlogModule } from './blog/blog.module';
import { MediaModule } from '../media/media.module';

/**
 * CMS 模块（Phase 4.1 起步，4.2 纳入 Products，4.3 纳入 Media，4.4 纳入 Blog）。
 * 控制器级挂 JwtAuthGuard：本模块所有接口默认要求登录。
 */
@Module({
  imports: [PrismaModule, ProductsModule, MediaModule, BlogModule],
  controllers: [CmsController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule {}
