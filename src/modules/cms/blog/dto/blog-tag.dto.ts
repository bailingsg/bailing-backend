import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { SLUG_MESSAGE, SLUG_REGEX } from '../../../../common/validators/slug';

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 创建博客标签（POST /api/v1/cms/blog/tags） */
export class CreateBlogTagDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  @MaxLength(160)
  slug!: string;
}

/** 更新博客标签（PATCH）：全部字段可选，未提供则不修改 */
export class UpdateBlogTagDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  @MaxLength(160)
  slug?: string;
}
