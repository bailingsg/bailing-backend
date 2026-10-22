import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { ListVisitorRecordsQueryDto } from '../dto/list-visitor-records-query.dto';
import { VisitorStatsService } from '../visitor-stats.service';

/**
 * 后台访客记录明细端点（访客统计实现规格 6.1）。
 *
 * 权限：`visitor_records.read`。本项目无 SUPPORT 角色，按权限 key 等价落地
 * 「仅 ADMIN」语义——seed 不把该权限授给 CONTENT_EDITOR / SALES，
 * 只有超级管理员（代码恒等于全集）可访问。
 *
 * 响应白名单（规格 6.5）：id / maskedIp / country / city / visitedAt。
 * 🔴 禁止返回 visitorId / userAgent / region / 完整 IP。
 */
@Controller('cms/visitor-records')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminVisitorRecordsController {
  constructor(private readonly stats: VisitorStatsService) {}

  /** GET /api/v1/cms/visitor-records?period=day|week|month&page&pageSize */
  @Get()
  @RequirePermissions('visitor_records.read')
  list(@Query() query: ListVisitorRecordsQueryDto) {
    return this.stats.records({
      period: query.period ?? 'day',
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });
  }
}
