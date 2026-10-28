import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

/** 明细查询天数白名单（与趋势图一致，避免开放任意天数放大查询成本） */
export const VISITOR_IP_DAYS = [7, 30] as const;

/**
 * 近期访客 IP 明细查询参数。
 *
 * 🔴 days 白名单只有 7 / 30：与 /cms/visitor-stats/trend 同一口径，
 * 开放任意天数会让大区间扫描变成资源放大攻击面；其它值一律 400，不静默回退。
 * 🔴 pageSize 上限 100：明细是访问级（不是会话级），条数天然比会话多，
 * 但仍必须封顶，否则一次请求能把整张表拉进内存。
 */
export class ListVisitorIpsQueryDto {
  @IsIn(VISITOR_IP_DAYS, { message: 'days 只接受 7 或 30' })
  @IsOptional()
  @Type(() => Number)
  days?: (typeof VISITOR_IP_DAYS)[number] = 7;

  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须 ≥ 1' })
  @Max(100, { message: 'pageSize 最大 100' })
  @IsOptional()
  @Type(() => Number)
  pageSize?: number = 50;

  /** IP 前缀过滤（如 `203.0.113.`），用于追查某个网段最近的访问 */
  @IsString({ message: 'ip 必须是字符串' })
  @MaxLength(45, { message: 'ip 长度不能超过 45' })
  @IsOptional()
  ip?: string;

  /** ISO 3166-1 alpha-2 国家代码过滤（如 US） */
  @IsString({ message: 'country 必须是字符串' })
  @Length(2, 2, { message: 'country 必须是两位国家代码' })
  @Matches(/^[A-Za-z]{2}$/, { message: 'country 必须是两位字母的国家代码' })
  @IsOptional()
  country?: string;
}
