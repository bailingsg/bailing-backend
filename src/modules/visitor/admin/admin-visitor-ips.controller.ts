import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { ListVisitorIpsQueryDto } from '../dto/list-visitor-ips-query.dto';
import { VisitorStatsService } from '../visitor-stats.service';

/**
 * 近期访客 IP 端点（「近期访客 IP」功能，2026-10-27）。
 *
 * 权限复用 `visitor_records.read`（seed 只授超级管理员）——没有另开
 * `visitor_ips.read`：两者是同一份经营分析数据的两种视图，拆成两个 key
 * 只会让「能看网段但不能看完整 IP」这种无意义组合出现。
 *
 * 响应白名单：id / ip / country / countryName / visitedAt，
 * 外加聚合用的 countries（国家分布）。🔴 不返回 userAgent，
 * 它是排障线索不是展示字段。
 */
@Controller('cms/visitor-ips')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminVisitorIpsController {
  constructor(private readonly stats: VisitorStatsService) {}

  /** GET /api/v1/cms/visitor-ips?days=7|30&page&pageSize&ip&country */
  @Get()
  @RequirePermissions('visitor_records.read')
  list(@Query() query: ListVisitorIpsQueryDto) {
    return this.stats.ipRecords({
      days: query.days ?? 7,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
      ip: query.ip,
      country: query.country,
    });
  }
}
