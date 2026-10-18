import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * 订单编号规范（Phase 5.3：业务员手动填写，全系统唯一）：
 *   · 允许字母、数字及 - _ / . # 分隔符与单个空格（不限制纯数字）；
 *   · 去除首尾空格（正则天然拒绝首尾空格），拒绝控制字符；
 *   · 长度 1-64；
 *   · 精确匹配、区分大小写——与数据库唯一索引（orders_code_key）行为一致，
 *     不做大小写折叠，避免把历史不同订单号误并。
 */
export const ORDER_CODE_PATTERN = /^[\p{L}\p{N}\-_.\/#]+(?: [\p{L}\p{N}\-_.\/#]+)*$/u;

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

  /** 关键词（模糊：订单编号 / 客户名称 / 客户需求） */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  /** 订单编号（精确查询，与其余筛选可叠加；校验前先 trim 首尾） */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(ORDER_CODE_PATTERN, { message: '订单编号格式不合法（仅限字母、数字及 - _ / . #）' })
  @MaxLength(64)
  code?: string;

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

/**
 * 订单必填业务字段（Create 与 Update 共用）。
 * 订单编号（code）只允许在新建时提交：编辑不开放修改订单号，
 * 因此 UpdateOrderDto 不含 code，防止部分更新误清/误改订单号。
 */
export class OrderFieldsDto {
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

export class CreateOrderDto extends OrderFieldsDto {
  /** 订单编号：业务员手动填写，全系统唯一（服务层 + 数据库双重保障） */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(ORDER_CODE_PATTERN, { message: '订单编号格式不合法（仅限字母、数字及 - _ / . #）' })
  @MinLength(1, { message: '订单编号不能为空' })
  @MaxLength(64, { message: '订单编号长度不能超过 64' })
  code!: string;
}

export class UpdateOrderDto extends OrderFieldsDto {
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
