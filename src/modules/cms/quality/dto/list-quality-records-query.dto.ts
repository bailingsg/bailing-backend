import { ContentStatus, QualityRecordType } from '@prisma/client';
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
 * 质量记录列表查询（GET /api/v1/cms/quality）。
 * keyword 匹配 title / slug / issuer / certificateNumber（不区分大小写）。
 */
export class ListQualityRecordsQueryDto {
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

  /** 记录类型筛选 */
  @IsOptional()
  @IsEnum(QualityRecordType)
  recordType?: QualityRecordType;

  /** 发布状态筛选 */
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;
}
