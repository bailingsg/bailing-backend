import {
  IsDateString,
  IsIn,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { INVENTORY_UNITS } from '../../inventory/dto/inventory.dto';

/**
 * 订单表单内联的库存信息（Phase 5.3.2）。
 *
 * 字段与校验规则与 CreateInventoryDto 完全对齐（产品名称 / 产品详情 / 数量 /
 * 计量单位 / 存放位置 / 存放日期），区别只有两点：
 *   · 不含 orderId —— 库存必然关联当前订单，由服务层从订单上下文写入，
 *     不接受客户端指定，避免把库存挂到别的订单上；
 *   · 不含 code / createdById —— 系统生成，恒为当前登录用户。
 */
export class OrderInventoryDto {
  @IsString({ message: '产品名称必须为字符串' })
  @MinLength(1, { message: '产品名称不能为空' })
  @MaxLength(160)
  productName!: string;

  @IsString({ message: '产品详情必须为字符串' })
  @MinLength(1, { message: '产品详情不能为空' })
  @MaxLength(5000)
  productDetail!: string;

  /** 数量：非负，最多三位小数（Decimal(14,3) 存储） */
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
}
