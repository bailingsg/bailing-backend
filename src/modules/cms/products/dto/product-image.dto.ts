import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 数值宽松解析：空串视为未提供 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 布尔宽松解析 */
function toBool({ value }: { value: unknown }): unknown {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return value;
}

/** 上传产品图片的附加字段（multipart 表单，除 file 外的文本字段） */
export class AddProductImageDto {
  /** 替代文本（SEO / 可访问性） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  alt?: string;

  /** 排序权重：越小越靠前 */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  /** 是否设为主图（列表卡片 / OG 图） */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isPrimary?: boolean;
}
