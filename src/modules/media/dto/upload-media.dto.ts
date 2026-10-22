import { MediaUsage } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';

/** 去首尾空白；空串视为「未提供」（multipart 表单总会带上该字段，留空不应报错） */
function toOptionalEnum({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 媒体上传的附加表单字段（POST /cms/media/upload，multipart）。
 *
 * 文件字段由 FileInterceptor 消费，其余文本字段（usage）落在 body 中。
 * usage 缺省 = 未分类（存量历史图同样为 null）。
 */
export class UploadMediaDto {
  @IsOptional()
  @Transform(toOptionalEnum)
  @IsEnum(MediaUsage, { message: '用途分类不合法（MediaUsage）' })
  usage?: MediaUsage;
}
