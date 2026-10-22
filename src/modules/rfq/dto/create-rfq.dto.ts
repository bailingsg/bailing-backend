import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** 去除首尾空白，避免把纯空格当作有效输入 */
function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * POST /api/v1/rfq 请求体。
 *
 * 与全局 ValidationPipe（whitelist + forbidNonWhitelisted）配合：
 * 任何未声明字段一律 400，可挡掉大部分脚本化垃圾提交。
 *
 * 必填（与前端表单一致）：name / company / email / country / message
 * 可选：phone / productId / productName / quantity / attachmentUrl
 */
export class CreateRfqDto {
  /** 联系人姓名 */
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** 公司名称 */
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  company!: string;

  /** 联系邮箱 */
  @Transform(trimString)
  @IsEmail()
  @MaxLength(160)
  email!: string;

  /** 电话（可选） */
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(60)
  phone?: string;

  /** 国家 / 地区 */
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  country!: string;

  /** 意向产品 ID（可选，来自产品详情页 Request Quote） */
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(80)
  productId?: string;

  /** 产品名称快照（可选） */
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  productName?: string;

  /** 采购需求（必填，长度限制用于防垃圾提交） */
  @Transform(trimString)
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  message!: string;

  /** 预估数量（可选，自由文本，如 "1 x 20GP"） */
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(80)
  quantity?: string;

  /** 附件地址（可选；本阶段仅登记，不做文件上传） */
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  attachmentUrl?: string;

  /**
   * 直发收件邮箱（可选，来自「发送给某销售」弹窗）。
   *
   * 访客在 Sales Contacts 卡片点击销售员邮箱时带上该字段：询盘直达该销售员的
   * 站内信箱，**不参与询盘轮转 / 倾斜计划分配**（避免占用他人的轮询顺位）。
   *
   * 安全约束：服务端会校验该邮箱必须是「已公开展示（showOnSite）且账号启用」
   * 的员工对外工作邮箱，否则视为无效并照常走轮询分配——公开接口绝不能被当成
   * 任意收件人的开放邮件中继。
   */
  @IsOptional()
  @Transform(trimString)
  @IsEmail()
  @MaxLength(160)
  directEmail?: string;
}
