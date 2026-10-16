import { Type, Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RfqStatus } from '@prisma/client';

/** 查询字符串里的布尔值 → boolean（'true'/'1' 视为 true） */
function toBoolean({ value }: { value: unknown }): unknown {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return value;
}

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

  /** 按承接人筛选（Phase 4.6） */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(64)
  assigneeId?: string;

  /**
   * 按是否已分配筛选（Phase 4.6）：
   *   true = 只要已分配承接人的询盘；false = 只要还没人认领的询盘
   */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'assigned 必须为布尔值' })
  assigned?: boolean;
}
