import { Type } from 'class-transformer';
import {
  IsDateString,
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

/** 计量单位白名单（单仓库业务常用单位） */
export const INVENTORY_UNITS = [
  '张',
  '片',
  '块',
  '套',
  '件',
  '根',
  '立方米',
  '平方米',
  '米',
  '千克',
  '吨',
] as const;

export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

export class ListInventoryQueryDto {
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

  /** 库存编号（精确匹配） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  /** 关键词（产品名称 / 产品详情模糊匹配） */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  /** 存放位置（模糊匹配） */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;

  /** 关联订单号（精确匹配；仅能搜到有权限查看的订单） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderCode?: string;

  @IsOptional()
  @IsDateString({}, { message: '存放日期起格式不合法' })
  storedFrom?: string;

  @IsOptional()
  @IsDateString({}, { message: '存放日期止格式不合法' })
  storedTo?: string;
}

export class CreateInventoryDto {
  @IsString({ message: '产品名称必须为字符串' })
  @MinLength(1, { message: '产品名称不能为空' })
  @MaxLength(160)
  productName!: string;

  @IsString({ message: '产品详情必须为字符串' })
  @MinLength(1, { message: '产品详情不能为空' })
  @MaxLength(5000)
  productDetail!: string;

  /** 数量：非负，最多三位小数（后端以 Decimal(14,3) 存储，避免浮点误差） */
  @IsNumber({ maxDecimalPlaces: 3 }, { message: '数量最多保留三位小数' })
  @Min(0, { message: '数量不允许为负数' })
  @Max(99_999_999.999)
  quantity!: number;

  @IsIn(INVENTORY_UNITS as unknown as string[], {
    message: `计量单位仅支持：${INVENTORY_UNITS.join(' / ')}`,
  })
  unit!: string;

  @IsString({ message: '存放位置必须为字符串' })
  @MinLength(1, { message: '存放位置不能为空' })
  @MaxLength(200)
  location!: string;

  @IsDateString({}, { message: '存放日期格式不合法' })
  storedAt!: string;

  /** 关联订单（可空；后端校验订单存在且当前用户有权关联） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderId?: string;
}

export class UpdateInventoryDto extends CreateInventoryDto {}
