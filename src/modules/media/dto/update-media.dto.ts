import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** 去首尾空白；空串 = 清空（可空字段） */
function trim({ value }: { value: unknown }): unknown {
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
}
