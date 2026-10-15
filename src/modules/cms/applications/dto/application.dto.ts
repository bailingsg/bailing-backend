import { ContentStatus } from '@prisma/client';
import { Type, Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SLUG_MESSAGE, SLUG_REGEX } from '../../../../common/validators/slug';

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 数值宽松解析：空串视为未提供 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/** 布尔宽松解析：接受 true / 'true' / 1 / '1' */
function toBool({ value }: { value: unknown }): unknown {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return value;
}

/** 空串 → undefined（可选字段统一语义，避免把 '' 写入数据库） */
function emptyToUndefined({ value }: { value: unknown }): unknown {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/**
 * 关联产品项。
 * productId 的存在性由 Service 批量校验（返回 400，避免外键异常）。
 */
export class ApplicationProductItemDto {
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  productId!: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

/**
 * 创建应用场景（POST /api/v1/cms/applications）。
 *
 * 产品关联约束：
 *   · 通过 ApplicationProduct 显式多对多建模，**不使用产品名字符串**匹配
 *   · productId 的存在性由 Service 校验，非法引用返回 400
 *   · 删除应用场景只解除关联（级联 application_products），**不删除 Product**
 */
export class CreateApplicationDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  @MaxLength(200)
  slug!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(64)
  coverMediaId?: string;

  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  publishedAt?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  seoTitle?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  seoDescription?: string;

  /** 关联产品集合（首次创建时给出） */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApplicationProductItemDto)
  products?: ApplicationProductItemDto[];
}

/**
 * 更新应用场景（PATCH）。
 * 传 products 数组表示**整体替换**关联产品集合。
 */
export class UpdateApplicationDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  @MaxLength(200)
  slug?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  coverMediaId?: string | null;

  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  publishedAt?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  seoTitle?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  seoDescription?: string;

  /** 传数组表示整体替换关联产品集合 */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApplicationProductItemDto)
  products?: ApplicationProductItemDto[];
}
