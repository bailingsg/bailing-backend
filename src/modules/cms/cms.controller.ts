import { Controller, Get, UseGuards } from '@nestjs/common';
import { CmsService } from './cms.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import type { CmsStatsDto } from './cms.dto';

/**
 * CMS 后台接口（Phase 4.1 起所有新增 CMS 接口必须 JWT 保护；
 * Phase 4.6 起同时要求功能权限）。
 *
 * 当前仅开放：
 *   GET /api/v1/cms/stats   Dashboard 真实统计（询盘 / 产品 / 分类 / 文章）
 *
 * Phase 0 起 RFQ 后台接口已并入 RBAC（rfq.read / rfq.update），
 * 由 RfqAuthGuard 统一鉴权，不再使用未配置即放行的共享密钥逻辑。
 */
@Controller('cms')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CmsController {
  constructor(private readonly cmsService: CmsService) {}

  /** Dashboard 统计卡片数据源 */
  @Get('stats')
  @RequirePermissions('dashboard.read')
  stats(): Promise<CmsStatsDto> {
    return this.cmsService.getStats();
  }
}
