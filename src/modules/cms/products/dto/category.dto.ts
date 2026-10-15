import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

/** 去首尾空白（保留内部空格） */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 布尔宽松解析：接受 true / 'true' / 1 / '1' */
function toBool({ value }: { value: unknown }): unknown {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return value;
}

/** 数值宽松解析：空串视为未提供 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/**
 * slug 格式：小写字母/数字/连字符，不允许连续连字符与首尾连字符。
 * 与公开产品 URL（/products/[slug]）约定一致。
 *
 * Phase 4.4：常量已上移到 src/common/validators/slug.ts（产品 / 博客共用），
 * 此处保留同名再导出以兼容既有引用。
 */
import { SLUG_MESSAGE, SLUG_REGEX } from '../../../../common/validators/slug';

export { SLUG_MESSAGE, SLUG_REGEX };
export { SLUG_PATTERN } from '../../../../common/validators/slug';

/**
 * 创建产品分类（POST /api/v1/cms/product-categories）。
 */
export class CreateCategoryDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, {
    message: 'slug 只能包含小写字母、数字与连字符（如 wood-products）',
  })
  @MaxLength(160)
  slug!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** 排序权重：越小越靠前 */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;
}

/**
 * 更新分类（PATCH）：全部字段可选，未提供则不修改。
 * 字段与 CreateCategoryDto 一致，逐一标注 @IsOptional。
 */
export class UpdateCategoryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, {
    message: 'slug 只能包含小写字母、数字与连字符（如 wood-products）',
  })
  @MaxLength(160)
  slug?: string;

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
  isActive?: boolean;
}
