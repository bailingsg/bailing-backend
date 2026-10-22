import { MediaUsage } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/** 数值宽松解析：空串视为未提供 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * 公开媒体列表查询（GET /api/v1/public/media）。
 *
 * 按**业务用途**（Phase 5.6 MediaUsage）取图：工厂 / 生产 / 装车 / 展会 /
 * 应用场景 / 站点配图等。页面据此自动聚合相关图片，无需在业务表里重复登记。
 */
export class PublicMediaListQueryDto {
  /** 用途筛选（BLOG / PRODUCT / FACTORY / PRODUCTION / LOADING / EXHIBITION / …） */
  @IsOptional()
  @Transform(trim)
  @IsEnum(MediaUsage)
  usage?: MediaUsage;

  /** 数量上限，默认 24，最大 48（公开接口保守） */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(48)
  limit?: number;
}
