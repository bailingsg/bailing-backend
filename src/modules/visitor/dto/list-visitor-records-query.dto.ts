import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** 明细查询周期（规格 6.2） */
export const VISITOR_RECORD_PERIODS = ['day', 'week', 'month'] as const;

/**
 * 访客记录查询参数（访客统计实现规格 6.2）。
 *
 * 🔴 非法值一律 400，不静默回退：静默改写会让界面显示的条数与实际请求不一致。
 * 🔴 pageSize 上限 50：超出直接 400。
 */
export class ListVisitorRecordsQueryDto {
  @IsIn(VISITOR_RECORD_PERIODS, { message: 'period 只接受 day / week / month' })
  @IsOptional()
  period?: (typeof VISITOR_RECORD_PERIODS)[number] = 'day';

  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须 ≥ 1' })
  @Max(50, { message: 'pageSize 最大 50' })
  @IsOptional()
  @Type(() => Number)
  pageSize?: number = 20;
}
