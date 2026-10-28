import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminVisitorIpsController } from './admin/admin-visitor-ips.controller';
import { AdminVisitorStatsController } from './admin/admin-visitor-stats.controller';
import { AdminVisitorRecordsController } from './admin/admin-visitor-records.controller';
import { GeoIpResolver } from './geoip/geoip.resolver';
import { OfflineGeoIpResolver } from './geoip/offline-geoip.resolver';
import { VisitorController } from './visitor.controller';
import { VisitorService } from './visitor.service';
import { VisitorStatsService } from './visitor-stats.service';
import { VisitorDailyAggregationWorker } from './visitor-daily-aggregation.worker';
import { VisitorIpCleanupWorker } from './visitor-ip-cleanup.worker';
import { VisitRateLimiter } from './visit-rate-limiter';

/**
 * 访客统计模块（匿名流量旁路能力）。
 *
 *   · POST /api/v1/visitor/track 公开无认证上报；
 *   · GET  /api/v1/cms/visitor-stats/overview|trend（visitor_stats.read）；
 *   · GET  /api/v1/cms/visitor-records（visitor_records.read，会话级明细）；
 *   · GET  /api/v1/cms/visitor-ips（visitor_records.read，近期访客 IP + 国家分布）；
 *   · VisitorDailyAggregationWorker 日聚合读模型 worker；
 *   · VisitorIpCleanupWorker 访客 IP 明细保留期清理 worker（默认 30 天）。
 *
 * 与账号/客户/订单体系零耦合：visitor_session / visitor_ip_log 均零外键，
 * 上报 DTO 只接受 visitorId。
 *
 * GeoIP 绑定在**这里**换：`GeoIpResolver` 是抽象 token，当前指向离线
 * GeoLite2-Country 实现（国家级精度）。换 City 库或在线 API 只改本文件，
 * VisitorService 与全部测试零改动。
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [
    VisitorController,
    AdminVisitorStatsController,
    AdminVisitorRecordsController,
    AdminVisitorIpsController,
  ],
  providers: [
    VisitorService,
    VisitorStatsService,
    VisitorDailyAggregationWorker,
    VisitorIpCleanupWorker,
    VisitRateLimiter,
    { provide: GeoIpResolver, useClass: OfflineGeoIpResolver },
  ],
  exports: [VisitorService],
})
export class VisitorModule {}
