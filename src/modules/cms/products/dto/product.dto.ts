
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
} from 'class-validator';
import { SLUG_MESSAGE, SLUG_REGEX } from './category.dto';

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

/**
 * 规格参数 JSON 结构：键值对、值为字符串/数字。
 * 例：{ "material": "Oak", "thickness": "18mm" }
 * 约束：最多 50 项，键 1–60 字符，值 ≤300 字符。
 * null / undefined 视为未提供（合法）。
 */
function isValidSpecifications(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) return false;
  return entries.every(
    ([k, v]) =>
      k.length > 0 &&
      k.length <= 60 &&
      (typeof v === 'string' || typeof v === 'number') &&
      String(v).length <= 300,
  );
}

@ValidatorConstraint({ name: 'isSpecifications' })
export class IsSpecificationsConstraint {
  validate(value: unknown): boolean {
    return isValidSpecifications(value);
  }

  defaultMessage(): string {
    return 'specifications 必须是键值对对象（最多 50 项，键 1-60 字符，值 ≤300 字符）';
  }
}

/** 应用标签校验：字符串数组，最多 20 项，每项 ≤60 字符 */
@ValidatorConstraint({ name: 'isApplications' })
export class IsApplicationsConstraint {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    if (value.length > 20) return false;
    return value.every((v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 60);
  }

  defaultMessage(): string {
    return 'applications 必须是非空字符串数组（最多 20 项，每项 ≤60 字符）';
  }
}

/**
 * 创建产品（POST /api/v1/cms/products）。
 *
 * categoryId 的存在性由 Service 校验（DTO 只保证格式），
 * 返回 400 明确错误而不是外键异常。
 */
export class CreateProductDto {
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

  /** 分类 ID（必须存在） */
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  categoryId!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  shortDescription?: string;

  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(20000)
  description!: string;

  /** 材质说明（公开站展示，向后兼容单值） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  material?: string;

  /** 应用标签（CMS Tag 输入），如 ["Furniture","Construction"] */
  @IsOptional()
  @Validate(IsApplicationsConstraint)
  applications?: string[];

  /** 规格参数键值对 */
  @IsOptional()
  @Validate(IsSpecificationsConstraint)
  specifications?: Record<string, string>;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isFeatured?: boolean;

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
}

/** 更新产品（PATCH）：全部字段可选，未提供则不修改 */
export class UpdateProductDto {
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
  @MaxLength(64)
  categoryId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  shortDescription?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  material?: string;

  @IsOptional()
  @Validate(IsApplicationsConstraint)
  applications?: string[];

  @IsOptional()
  @Validate(IsSpecificationsConstraint)
  specifications?: Record<string, string>;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isFeatured?: boolean;

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
}
