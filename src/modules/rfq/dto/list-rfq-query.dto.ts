import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { RfqStatus } from '@prisma/client';

/**
 * GET /api/v1/rfq 查询参数（管理后台使用）。
 *
 * 与全局 ValidationPipe 约定一致：未声明参数 → 400。
 */
export class ListRfqQueryDto {
  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 每页数量，上限 100 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  /** 按状态筛选 */
  @IsOptional()
  @IsEnum(RfqStatus)
  status?: RfqStatus;
}
