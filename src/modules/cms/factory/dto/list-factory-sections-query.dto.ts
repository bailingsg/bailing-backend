import { ContentStatus, FactorySectionType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 数值宽松解析：空串视为未提供 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * 工厂分区列表查询（GET /api/v1/cms/factory）。
 * keyword 匹配 title / slug / summary（不区分大小写）。
 */
export class ListFactorySectionsQueryDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page?: number;

  /** 每页数量，默认 20，最大 100 */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  keyword?: string;

  /** 内容类型筛选 */
  @IsOptional()
  @IsEnum(FactorySectionType)
  sectionType?: FactorySectionType;

  /** 发布状态筛选 */
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;
}
