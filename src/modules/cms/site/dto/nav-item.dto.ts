import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { NavLocation } from '@prisma/client';

const trimToUndefined = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/** 数值宽松解析：空串视为未提供 */
const toInt = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
};

/** 站内导航项位置 / 启用状态筛选查询 */
export class ListNavItemsQueryDto {
  @IsOptional()
  @IsEnum(NavLocation)
  location?: NavLocation;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;
}

export class CreateNavItemDto {
  @IsEnum(NavLocation)
  location!: NavLocation;

  @IsString()
  @Length(1, 40)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  label!: string;

  /** 目标 URL——服务层用 normalizeSiteUrl 强制校验（拒绝 javascript: 等） */
  @IsString()
  @Length(1, 300)
  url!: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  openInNewTab?: boolean;
}

export class UpdateNavItemDto {
  @IsOptional()
  @IsString()
  @Length(1, 40)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  label?: string;

  /** 目标 URL——服务层用 normalizeSiteUrl 强制校验 */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 300)
  url?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  openInNewTab?: boolean;
}
