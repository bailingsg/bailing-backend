import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MediaModule } from '../../media/media.module';
import { ProductCategoriesController } from './product-categories.controller';
import { ProductCategoriesService } from './product-categories.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/**
 * CMS Products 模块（Phase 4.2）。
 *
 * 范围仅限产品体系：分类 CRUD、产品 CRUD、产品图片管理。
 * 控制器级 JwtAuthGuard（见各 controller），不在本模块重复注册守卫。
 *
 * Phase 6.0：引入 MediaModule 以拿到 STORAGE_PROVIDER ——
 * 产品图片与媒体库走同一条存储链路（COS / 本地），不再各自落盘。
 */
@Module({
  imports: [PrismaModule, MediaModule],
  controllers: [ProductsController, ProductCategoriesController],
  providers: [ProductsService, ProductCategoriesService],
  exports: [ProductsService, ProductCategoriesService],
})
export class ProductsModule {}
