import { Injectable } from '@nestjs/common';

/** GeoIP 解析结果（规格 4.2 ③）。region 存库但不对外返回。 */
export interface GeoIpResult {
  country: string | null;
  region: string | null;
  city: string | null;
}

/** 空结果（未启用离线库 / 未收录时的统一出口） */
export const EMPTY_GEO_IP: GeoIpResult = { country: null, region: null, city: null };

/**
 * GeoIP 解析器抽象（访客统计实现规格 4.3 红线 1）。
 *
 * 调用方（VisitorService）拿到的永远是**完整 IP**——脱敏必须在解析之后，
 * 否则先截断成网段就再也解析不出城市级精度。
 *
 * 当前实现为 NoopGeoIpResolver（无离线 .mmdb 数据，country/city 恒 null，
 * 前端显示「未知」——规格 9.3 允许空值）。未来引入 GeoLite2-City 时
 * 新增一个 OfflineGeoIpResolver 并在 VisitorModule 换绑定即可，
 * 业务代码零改动。
 */
@Injectable()
export class NoopGeoIpResolver {
  resolve(_fullIp: string): GeoIpResult {
    return EMPTY_GEO_IP;
  }
}
