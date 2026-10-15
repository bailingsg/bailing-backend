import { ContentStatus, FactorySectionType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
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
 * 分区图库视频/图片关联项。
 * mediaId 的存在性由 Service 校验（返回 400 明确错误，而非外键异常）。
 */
export class FactoryImageItemDto {
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  mediaId!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  altText?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

/** 参展记录（内嵌于分区创建/更新） */
export class FactoryExhibitionItemDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  id?: string; // 传入表示更新既有记录；不传表示新建

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  heldOn?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isVisible?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FactoryImageItemDto)
  photos?: FactoryImageItemDto[];
}

/**
 * 创建工厂分区（POST /api/v1/cms/factory）。
 *
 * 约束分工：
 *   · DTO 做格式、枚举与长度校验
 *   · coverMediaId / images[].mediaId / exhibitions[].photos[].mediaId 的**存在性**
 *     由 Service 校验（返回 400）
 *   · content 的 XSS 过滤由 Service 调用 sanitizeRichText 完成
 */
export class CreateFactorySectionDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  @MaxLength(200)
  slug!: string;

  @IsEnum(FactorySectionType)
  sectionType!: FactorySectionType;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50000)
  content?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(64)
  coverMediaId?: string;

  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FactoryImageItemDto)
  images?: FactoryImageItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FactoryExhibitionItemDto)
  exhibitions?: FactoryExhibitionItemDto[];
}

/**
 * 更新工厂分区（PATCH）。
 * 所有字段可选；显式传 null 表示清空可空字段（Service 侧处理 null 语义）。
 */
export class UpdateFactorySectionDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  @MaxLength(200)
  slug?: string;

  @IsOptional()
  @IsEnum(FactorySectionType)
  sectionType?: FactorySectionType;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50000)
  content?: string;

  @IsOptional()
  coverMediaId?: string | null;

  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

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

  /** 传数组表示整体替换分区图库（不含展会照片） */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FactoryImageItemDto)
  images?: FactoryImageItemDto[];

  /** 传数组表示整体替换展会记录集合 */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FactoryExhibitionItemDto)
  exhibitions?: FactoryExhibitionItemDto[];
}
