import { ContentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** 数值宽松解析：空串视为未提供 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/** 布尔宽松解析 */
function toBool({ value }: { value: unknown }): unknown {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return value;
}

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * 应用场景列表查询（GET /api/v1/cms/applications）。
 * keyword 匹配 name / slug / summary（不区分大小写）。
 */
export class ListApplicationsQueryDto {
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

  /** 发布状态筛选 */
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  /** 仅看推荐（首页应用场景） */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  featured?: boolean;
}
