import { Injectable } from '@nestjs/common';

/** GeoIP 解析结果（规格 4.2 ③）。region 存库但不对外返回。 */
export interface GeoIpResult {
  country: string | null;
  region: string | null;
  city: string | null;
}

/** 空结果（未启用离线库 / 未收录 / 内网地址时的统一出口） */
export const EMPTY_GEO_IP: GeoIpResult = { country: null, region: null, city: null };

/**
 * GeoIP 解析器抽象（访客统计实现规格 4.3 红线 1）。
 *
 * 调用方（VisitorService）拿到的永远是**完整 IP**——脱敏必须在解析之后，
 * 否则先截断成网段就再也解析不出地域。
 *
 * 用抽象类而不是具体类做注入 token：换数据源（Country → City、离线库 →
 * 在线 API）时只改 VisitorModule 的绑定，VisitorService 零改动。
 *
 * 当前绑定：`OfflineGeoIpResolver`（离线 GeoLite2-Country，国家级精度）。
 */
export abstract class GeoIpResolver {
  abstract resolve(fullIp: string): GeoIpResult;
}

/**
 * 空实现：恒返回 null（前端显示「未知」）。
 *
 * 生产已换成 OfflineGeoIpResolver；本类保留两个用途：
 *   1. 单测 / e2e 需要确定性的「无地理信息」场景；
 *   2. mmdb 文件缺失或损坏时的降级目标——统计不能因为地理库挂了而整体不可用。
 */
@Injectable()
export class NoopGeoIpResolver extends GeoIpResolver {
  resolve(_fullIp: string): GeoIpResult {
    return EMPTY_GEO_IP;
  }
}
