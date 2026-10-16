import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ContentStatus, SitePage } from '@prisma/client';

/** 去掉首尾空白；空串转 undefined（表示「未提供」） */
const trimToUndefined = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/** 数值宽松解析：空串视为未提供 */
const toInt = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
};

/** 结构化卡片项：定式字段 + 白名单校验（不是页面构建器） */
export class SiteSectionItemDto {
  @IsString()
  @Length(1, 120)
  title!: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 400)
  description?: string;

  /** 卡片链接（可选）——必须通过 URL 安全校验（服务层二次把关） */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 300)
  href?: string;
}

/** 结构化统计项：[{label, value}]，最多 6 个，字段白名单 */
export class SiteSectionStatDto {
  @IsString()
  @Length(1, 40)
  label!: string;

  @IsString()
  @Length(1, 40)
  value!: string;
}

/**
 * 站点分区列表查询。
 *
 * 注意：`page` 是站点页面过滤器（HOME / ABOUT / CONTACT）；
 * 分页参数命名为 `pageNum` / `pageSize`，避免与页面过滤器同名冲突。
 */
export class ListSiteSectionsQueryDto {
  @IsOptional()
  @IsEnum(SitePage)
  page?: SitePage;

  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 60)
  keyword?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  pageNum?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CreateSiteSectionDto {
  @IsEnum(SitePage)
  page!: SitePage;

  @IsString()
  @Length(1, 60)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  sectionKey!: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 120)
  eyebrow?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 300)
  subtitle?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 20000)
  body?: string;

  /** 关联媒体库资产（null / undefined = 不设置） */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  mediaId?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 60)
  ctaLabel?: string;

  /** CTA 链接——服务层用 normalizeSiteUrl 校验（拒绝 javascript: 等） */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 300)
  ctaUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SiteSectionItemDto)
  items?: SiteSectionItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => SiteSectionStatDto)
  stats?: SiteSectionStatDto[];

  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

export class UpdateSiteSectionDto {
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 120)
  eyebrow?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 300)
  subtitle?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 20000)
  body?: string;

  /** null = 清空媒体引用 */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  mediaId?: string | null;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 60)
  ctaLabel?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 300)
  ctaUrl?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SiteSectionItemDto)
  items?: SiteSectionItemDto[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => SiteSectionStatDto)
  stats?: SiteSectionStatDto[] | null;

  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}
