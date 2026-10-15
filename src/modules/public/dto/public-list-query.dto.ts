import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 数值宽松解析 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/**
 * 公开列表通用分页参数（GET /api/v1/public/*）。
 * 参数严格白名单，未声明参数触发 400。
 */
export class PublicListQueryDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page?: number;

  /** 每页数量，默认 20，上限 48（公开上限更保守） */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(48)
  pageSize?: number;
}

/** 公开工厂分区列表查询 */
export class PublicFactoryListQueryDto extends PublicListQueryDto {
  /** 按内容类型筛选（OVERVIEW / FACILITY / ...） */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(40)
  sectionType?: string;
}

/** 公开应用场景列表查询 */
export class PublicApplicationsListQueryDto extends PublicListQueryDto {
  /** 只看推荐（'true'） */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(10)
  featured?: string;
}

/** 公开质量列表查询 */
export class PublicQualityListQueryDto extends PublicListQueryDto {
  /** 按记录类型筛选 */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(40)
  recordType?: string;
}
