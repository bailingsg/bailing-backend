import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { OrderFileService } from './order-file.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * 订单管理模块（Phase 5.2）。
 * 附件存储独立于媒体库（orders/ 命名空间，非静态目录，鉴权读取）。
 */
@Module({
  imports: [RbacModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderFileService],
  exports: [OrdersService],
})
export class OrdersModule {}
