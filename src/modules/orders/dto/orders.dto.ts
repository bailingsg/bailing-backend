import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ListOrdersQueryDto {
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
  @IsString()
  @MaxLength(80)
  country?: string;

  /** 仅管理员生效：按业务员筛选 */
  @IsOptional()
  @IsString()
  salespersonId?: string;

  @IsOptional()
  @IsDateString({}, { message: '下单时间范围格式不合法' })
  orderedFrom?: string;

  @IsOptional()
  @IsDateString({}, { message: '下单时间范围格式不合法' })
  orderedTo?: string;

  /** 成交状态：closed=已成交（closedAt 非空）、open=未成交 */
  @IsOptional()
  @IsIn(['closed', 'open'])
  closedState?: 'closed' | 'open';
}

export class CreateOrderDto {
  @IsString()
  @MinLength(1, { message: '客户名称不能为空' })
  @MaxLength(160)
  customerName!: string;

  @IsString()
  @MinLength(1, { message: '国家/地区不能为空' })
  @MaxLength(80)
  country!: string;

  @IsString()
  @MinLength(1, { message: '客户需求不能为空' })
  @MaxLength(5000)
  requirement!: string;

  @IsDateString({}, { message: '下单时间格式不合法' })
  orderedAt!: string;

  @IsOptional()
  @IsDateString({}, { message: '成交时间格式不合法' })
  closedAt?: string;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: '金额最多保留两位小数' })
  @Min(0, { message: '金额不允许为负数' })
  @Max(9_999_999_999.99)
  amount!: number;

  @IsEnum(['CNY', 'USD', 'EUR'], { message: '币种只允许 CNY / USD / EUR' })
  currency!: 'CNY' | 'USD' | 'EUR';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** 待关联的附件 ID（必须为当前用户上传且尚未关联的附件） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentIds?: string[];
}

export class UpdateOrderDto extends CreateOrderDto {
  /** 编辑时要移除的附件 ID（必须属于本订单） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  removeAttachmentIds?: string[];
}

export class CreateOrderUploadDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientName?: string;
}
