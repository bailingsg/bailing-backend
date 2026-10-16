import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/** 去首尾空白；空串保留（表示清空可空字段，服务层转 null） */
function trimOrClear({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed;
}

/** 宽松布尔解析（'true' / '1'） */
function toBool({ value }: { value: unknown }): unknown {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
}

/** 宽松数值解析：空串视为未提供 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/**
 * 更新统一 SEO 档案（PUT /cms/seo/profiles/:entityType/:entityId）。
 *
 * 字段语义（与后台编辑器契约）：
 *   · 未传（undefined）= 不修改；
 *   · 传空串（''）= 清空该可空字段（服务层转 null，恢复内容层兜底）；
 *   · 布尔字段未传不修改，传值即覆盖。
 */
export class UpdateSeoProfileDto {
  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(200)
  metaTitle?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(500)
  metaDescription?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(500)
  canonicalUrl?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  robotsIndex?: boolean;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  robotsFollow?: boolean;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(120)
  focusKeyword?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(300)
  keywords?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(200)
  ogTitle?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(500)
  ogDescription?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(500)
  ogImage?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(200)
  twitterTitle?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(500)
  twitterDescription?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(500)
  twitterImage?: string;

  @IsOptional()
  @IsIn(['NONE', 'WEB_PAGE', 'PRODUCT', 'ARTICLE', 'FAQ_PAGE'])
  schemaType?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(20000)
  schemaData?: string;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(8000)
  relatedData?: string;
}

/** 快捷修复（POST /cms/seo/profiles/:type/:id/quick-fix） */
export class QuickFixSeoDto {
  @IsIn(['canonicalUrl', 'metaTitle', 'metaDescription', 'ogImage'], { each: true })
  fields!: string[];

  /** true = 仅预览将生成的 diff，不写入（任务书三十三节：修复前必须显示修改内容） */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  dryRun?: boolean;
}

/** SEO 列表查询（pages/products/blog 共用） */
export class ListSeoEntitiesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @Length(0, 120)
  keyword?: string;

  @IsOptional()
  @IsIn(['UNAUDITED', 'GOOD', 'NEEDS_IMPROVEMENT', 'POOR'])
  status?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  issuesOnly?: boolean;
}

/** 重定向创建 */
export class CreateSeoRedirectDto {
  @Transform(trimOrClear)
  @IsString()
  @Length(1, 500)
  sourcePath!: string;

  @Transform(trimOrClear)
  @IsString()
  @Length(1, 2000)
  targetPath!: string;

  @IsOptional()
  @Type(() => Number)
  @Transform(toInt)
  @IsInt()
  @IsIn([301, 302])
  statusCode?: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** 重定向更新 */
export class UpdateSeoRedirectDto {
  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @Length(1, 2000)
  targetPath?: string;

  @IsOptional()
  @Type(() => Number)
  @Transform(toInt)
  @IsInt()
  @IsIn([301, 302])
  statusCode?: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** 重定向列表查询 */
export class ListSeoRedirectsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @Transform(trimOrClear)
  @IsString()
  @Length(0, 120)
  keyword?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;
}
