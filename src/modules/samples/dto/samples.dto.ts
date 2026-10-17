import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 样品业务状态（OUT 为系统归档态，不接受任何接口直接写入） */
export const SAMPLE_VISIBLE_STATUSES = ['IN_STOCK', 'REQUEST_OUT', 'REJECTED'] as const;

export class CreateSampleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  spec?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  material?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  usage?: string;

  @IsInt()
  @Min(1, { message: '数量必须为正整数，不允许负数或 0' })
  @Max(1_000_000)
  quantity!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  unit!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  location!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class UpdateSampleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  spec?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  material?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  usage?: string;

  @IsOptional()
  @IsInt()
  @Min(1, { message: '数量必须为正整数，不允许负数或 0' })
  @Max(1_000_000)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class ListSamplesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsIn(SAMPLE_VISIBLE_STATUSES)
  status?: (typeof SAMPLE_VISIBLE_STATUSES)[number];

  /** 仅管理员生效：按持有人筛选 */
  @IsOptional()
  @IsString()
  ownerId?: string;
}

export class GrantSamplesDto {
  /** 被授权查看的用户 ID 列表 */
  @IsArray()
  @ArrayMinSize(1, { message: '至少选择一名被授权人' })
  @IsString({ each: true })
  userIds!: string[];
}

export class CreateSampleRequestDto {
  @IsString()
  @MinLength(1, { message: '申请说明不能为空' })
  @MaxLength(1000)
  purpose!: string;
}

export class DecideSampleRequestDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';
}

export class ListSampleRequestsQueryDto {
  /** scope=pending：指向我持有样品的待审批申请；mine：我发起的申请；all：全部（管理员） */
  @IsIn(['pending', 'mine', 'all'])
  scope!: 'pending' | 'mine' | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
