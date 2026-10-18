import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * 库存管理模块（Phase 5.3，单仓库）。
 *
 * RbacModule 提供权限解析（RbacService）与审计（AuditLogService）。
 */
@Module({
  imports: [RbacModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
