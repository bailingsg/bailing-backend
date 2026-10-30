import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * GET /api/v1/products 查询参数。
 *
 * 与全局 ValidationPipe 约定一致：whitelist + forbidNonWhitelisted，
 * 传入未声明参数将返回 400，保证接口契约严格。
 */
export class ListProductsQueryDto {
  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 每页数量，上限 48 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  pageSize?: number;

  /** 分类 slug（对应 Category.slug） */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  /** 是否只看精选（'true' / 'false'） */
  @IsOptional()
  @IsBooleanString()
  featured?: string;

  /**
   * 关键词搜索（2026-10-30 新增，前台 /products 搜索框使用）。
   *
   * 匹配范围：产品名 / 简述 / 材质，大小写不敏感，包含即命中。
   * 与 category / featured 是 AND 关系，可与分类筛选叠加。
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}
