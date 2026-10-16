import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { PermissionsGuard } from './permissions.guard';
import { AuditLogService } from './audit-log.service';

/**
 * RBAC 模块（Phase 4.6）。
 *
 * @Global：权限校验横切所有 CMS 接口，各业务模块无需重复 import。
 * 导出 PermissionsGuard 供各控制器 @UseGuards(JwtAuthGuard, PermissionsGuard) 使用；
 * 导出 RbacService / AuditLogService 供账号、角色、询盘分配模块复用。
 */
@Global()
@Module({
  providers: [RbacService, PermissionsGuard, AuditLogService],
  exports: [RbacService, PermissionsGuard, AuditLogService],
})
export class RbacModule {}
