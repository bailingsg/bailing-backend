import { PostStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { SLUG_MESSAGE, SLUG_REGEX } from '../../../../common/validators/slug';

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 布尔宽松解析：接受 true / 'true' / 1 / '1' */
function toBool({ value }: { value: unknown }): unknown {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return value;
}

/** tagIds 校验：字符串数组，最多 30 项，每项 ≤64 字符（cuid） */
@ValidatorConstraint({ name: 'isTagIdList' })
export class IsTagIdListConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    if (value.length > 30) return false;
    return value.every((v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 64);
  }

  defaultMessage(): string {
    return 'tagIds 必须是非空字符串数组（最多 30 项，每项 ≤64 字符）';
  }
}

/**
 * 创建博客文章（POST /api/v1/cms/blog/posts）。
 *
 * 约束分工：
 *   · DTO 只做格式与长度校验
 *   · categoryId / coverMediaId / tagIds 的**存在性**由 Service 校验（返回 400 明确错误）
 *   · content 的 XSS 过滤由 Service 调用 sanitizeRichText 完成
 */
export class CreateBlogPostDto {
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

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  /** 富文本正文（HTML），写入前经白名单净化 */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200000)
  content!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  categoryId?: string;

  /** 封面媒体（MediaAsset.id，Phase 4.3 Media Library） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  coverMediaId?: string;

  @IsOptional()
  @Validate(IsTagIdListConstraint)
  tagIds?: string[];

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  /** 发布时间（ISO 8601）。未提供且状态为 PUBLISHED 时由 Service 置为当前时间 */
  @IsOptional()
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
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  seoKeywords?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  canonicalUrl?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  ogTitle?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  ogDescription?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  ogImage?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  twitterTitle?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  twitterDescription?: string;
}

/**
 * 更新博客文章（PATCH）：全部字段可选，未提供则不修改。
 *
 * 三态语义（Service 据此决定写入）：
 *   · undefined（字段缺省）→ 保持不变
 *   · null（显式传 null，@IsOptional 放行）→ 置空
 *   · 有值 → 覆盖
 *
 * 因此可空字段的声明类型为 `string | null`。
 */
export class UpdateBlogPostDto {
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
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  excerpt?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200000)
  content?: string;

  /** 传 null 表示解除分类关联 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  categoryId?: string | null;

  /** 传 null 表示解除封面关联 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  coverMediaId?: string | null;

  @IsOptional()
  @Validate(IsTagIdListConstraint)
  tagIds?: string[];

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  /** 传 null 表示清空发布时间（取消发布时由 Service 一并处理） */
  @IsOptional()
  @IsISO8601()
  publishedAt?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  seoTitle?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  seoDescription?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  seoKeywords?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  canonicalUrl?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  ogTitle?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  ogDescription?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  ogImage?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  twitterTitle?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  twitterDescription?: string | null;
}
