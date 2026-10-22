import { MediaUsage } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** 去首尾空白；空串 = 清空（可空字段） */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 用途字段：空串 / null → 清空为「未分类」，其余原样交给 IsEnum 校验 */
function toNullableUsage({ value }: { value: unknown }): unknown {
  if (value === null || value === '') return null;
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * 媒体 SEO 元数据更新（PATCH /cms/media/:id，Phase 5.0 图片 SEO）。
 *
 * alt / title / caption / description 全部可空：空串表示清除。
 */
export class UpdateMediaDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  altText?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  caption?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  /**
   * 用途分类（Phase 5.6）。三态：缺省 = 不变；空串 / null = 置为未分类；有值 = 覆盖。
   */
  @IsOptional()
  @Transform(toNullableUsage)
  @IsEnum(MediaUsage, { message: '用途分类不合法（MediaUsage）' })
  usage?: MediaUsage | null;
}
