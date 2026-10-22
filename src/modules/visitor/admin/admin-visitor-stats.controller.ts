import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { VisitorTrendQueryDto } from '../dto/visitor-trend-query.dto';
import { VisitorStatsService } from '../visitor-stats.service';

/**
 * 后台访客统计聚合端点（访客统计实现规格 5.1 / 5.2）。
 *
 * 权限映射（评审决策 D1：本项目无 SUPPORT 角色，按权限 key 等价落地）：
 *   · overview / trend → `visitor_stats.read`
 *   · 明细（visitor-records）→ `visitor_records.read`，seed 只授超管
 *
 * 路由前缀按本项目后台约定落在 /cms 下（规格的 /admin 路径改写为
 * /api/v1/cms/visitor-stats，契约字段与行为不变）。
 */
@Controller('cms/visitor-stats')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminVisitorStatsController {
  constructor(private readonly stats: VisitorStatsService) {}

  /** GET /api/v1/cms/visitor-stats/overview —— 今日实时 + 7/30 日区间 */
  @Get('overview')
  @RequirePermissions('visitor_stats.read')
  overview() {
    return this.stats.overview();
  }

  /** GET /api/v1/cms/visitor-stats/trend?days=7|30 —— 升序、补 0、末项今日 */
  @Get('trend')
  @RequirePermissions('visitor_stats.read')
  trend(@Query() query: VisitorTrendQueryDto) {
    return this.stats.trend(query.days);
  }
}
