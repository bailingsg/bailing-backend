import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Reader, type CountryResponse } from 'mmdb-lib';
import { normalizeIp } from '../ip-normalize';
import { EMPTY_GEO_IP, GeoIpResolver, type GeoIpResult } from './geoip.resolver';

/**
 * 离线 GeoIP 解析器（GeoLite2-Country，国家级精度）。
 *
 * 数据来源：npm 包 `@ip-location-db/geolite2-country-mmdb`
 * （GeoLite2 Country 库的 npm 分发版，随 `npm ci` 进镜像，无需手工下载
 * 或 MaxMind license key；数据库约 8.8MB，IPv4 + IPv6 合并单文件）。
 *
 * 三条设计约束：
 *   1. **只做国家级**——需求是「知道客户来自哪个国家」，City 库体积大 5 倍
 *      且需要额外字段，收益不成立；region / city 恒返回 null；
 *   2. **加载失败必须降级**——文件缺失 / 损坏 / 格式不对时记一条错误日志并
 *      永久退回 null，绝不抛错：访客统计是旁路能力，不能因为地理库挂了
 *      让整个 track 端点 500；
 *   3. **只吃完整 IP**——调用方（VisitorService）必须先解析再脱敏，
 *      顺序反了这里拿到的就是网段，永远查不出结果。
 *
 * 数据库更新：`npm update @ip-location-db/geolite2-country-mmdb` 后重建镜像；
 * 或挂载新库并把 `GEOIP_COUNTRY_MMDB_PATH` 指向文件（不重建镜像即可换库）。
 */

/** 默认 npm 数据包（无 exports 字段，可用 require.resolve 定位 package.json） */
const MMDB_PACKAGE = '@ip-location-db/geolite2-country-mmdb';

/** 包内合并 IPv4 + IPv6 的单文件 */
const MMDB_FILE = 'geolite2-country.mmdb';

/**
 * 该库的精简记录结构（非标准 MaxMind 嵌套格式）。
 *
 * 实测 `@ip-location-db/geolite2-country-mmdb` 返回的是扁平结构：
 *   { "country_code": "US" }
 * 而标准 MaxMind Country 库是 { country: { iso_code: "US" } }。
 * 两种都认，将来换回官方库不用改代码。
 */
interface CompactCountryRecord {
  country_code?: string;
  country?: { iso_code?: string };
}

@Injectable()
export class OfflineGeoIpResolver extends GeoIpResolver implements OnModuleInit {
  private readonly logger = new Logger(OfflineGeoIpResolver.name);
  private reader: Reader<CountryResponse> | null = null;

  async onModuleInit(): Promise<void> {
    const file = this.resolveDatabasePath();
    try {
      const buffer = await readFile(file);
      this.reader = new Reader<CountryResponse>(buffer);
      // 日志只允许「已加载 / 失败」这类无参消息，不得出现任何 IP（规格 10.4）
      this.logger.log('GeoIP 国家库已加载（GeoLite2-Country，国家级精度）');
    } catch (error) {
      // 降级为 null，不抛错（约束 2）
      this.logger.error(
        `GeoIP 国家库加载失败，地域信息将显示为未知：${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /** 数据库路径：环境变量优先，否则取 npm 包内文件 */
  private resolveDatabasePath(): string {
    const fromEnv = process.env.GEOIP_COUNTRY_MMDB_PATH?.trim();
    if (fromEnv) return fromEnv;
    try {
      return join(dirname(require.resolve(`${MMDB_PACKAGE}/package.json`)), MMDB_FILE);
    } catch {
      // 包没装（例如精简部署）时返回一个必然失败但可读的路径，交给调用方降级
      return join(process.cwd(), 'node_modules', MMDB_PACKAGE, MMDB_FILE);
    }
  }

  resolve(fullIp: string): GeoIpResult {
    const reader = this.reader;
    if (!reader) return EMPTY_GEO_IP;

    const ip = normalizeIp(fullIp);
    if (!ip) return EMPTY_GEO_IP;

    try {
      // 该库返回扁平结构，与 CountryResponse 的嵌套声明不一致，故做一次断言
      const record = reader.get(ip) as unknown as CompactCountryRecord | null;
      if (!record) return EMPTY_GEO_IP;
      const code = record.country_code ?? record.country?.iso_code ?? null;
      if (!code) return EMPTY_GEO_IP;
      // 国家代码统一大写（ISO 3166-1 alpha-2），region / city 本库不提供
      return { country: code.toUpperCase(), region: null, city: null };
    } catch {
      // 非法 IP / 库损坏：单次查询失败不影响其它请求
      return EMPTY_GEO_IP;
    }
  }
}
