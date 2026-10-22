import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminVisitorStatsController } from './admin/admin-visitor-stats.controller';
import { AdminVisitorRecordsController } from './admin/admin-visitor-records.controller';
import { NoopGeoIpResolver } from './geoip/geoip.resolver';
import { VisitorController } from './visitor.controller';
import { VisitorService } from './visitor.service';
import { VisitorStatsService } from './visitor-stats.service';
import { VisitorDailyAggregationWorker } from './visitor-daily-aggregation.worker';
import { VisitRateLimiter } from './visit-rate-limiter';

/**
 * 访客统计模块（匿名流量旁路能力）。
 *
 *   · POST /api/v1/visitor/track 公开无认证上报（M1）；
 *   · GET  /api/v1/cms/visitor-stats/overview|trend（M2，visitor_stats.read）；
 *   · GET  /api/v1/cms/visitor-records（M3，visitor_records.read，仅超管）；
 *   · VisitorDailyAggregationWorker 日聚合读模型 worker（M2）。
 *
 * 与账号/客户/订单体系零耦合：两张表零外键，上报 DTO 只接受 visitorId。
 * 限流器与 GeoIP 解析器在本模块内提供，未来换 mmdb 离线库只改这里。
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [VisitorController, AdminVisitorStatsController, AdminVisitorRecordsController],
  providers: [
    VisitorService,
    VisitorStatsService,
    VisitorDailyAggregationWorker,
    VisitRateLimiter,
    NoopGeoIpResolver,
  ],
  exports: [VisitorService],
})
export class VisitorModule {}
