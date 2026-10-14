import { MediaCategory } from '@prisma/client';
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
 * 媒体列表查询（GET /api/v1/cms/media）。
 * keyword 匹配 originalName / filename（不区分大小写）。
 */
export class ListMediaQueryDto {
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

  /** 搜索关键词（原始文件名 / 存储文件名） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  keyword?: string;

  /** 分类筛选：IMAGE / DOCUMENT */
  @IsOptional()
  @IsEnum(MediaCategory)
  category?: MediaCategory;
}
