import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

/**
 * 角色与权限管理模块（Phase 4.6）。
 * RbacModule 为 @Global，此处无需重复 import（RbacService / AuditLogService 直接可用）。
 */
@Module({
  imports: [PrismaModule],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
