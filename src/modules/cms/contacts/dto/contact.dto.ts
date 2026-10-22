import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 空串 → undefined（可选字段统一语义） */
function emptyToUndefined({ value }: { value: unknown }): unknown {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function toBool({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
}

/**
 * WhatsApp 国际号码归一化。
 *
 * 规则（规格要求「明确的国际国家代码」）：
 *   · 只接受 **digits only**（允许空格/连字符/( ) 等分隔符，归一化时剔除）
 *   · 必须以 `+` 开头；无 `+` 的一律视为不合规（避免国家代码歧义）
 *   · 数字总长度 8–15 位（ITU-T E.164 上限 15）
 *   · 不自动推断国家代码——不做「猜测」，缺国家代码必须由操作人补全
 *
 * @returns 归一化后的 E.164 形式（如 +8613800138000）；非法时返回 null
 */
export function normalizeWhatsapp(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[\s\-()[\]]/g, '');
  if (!/^\+\d{8,15}$/.test(stripped)) return null;
  return stripped;
}

/** WhatsApp 填写提示（中文，前端 form 帮助文本与校验错误共用） */
export const WHATSAPP_HINT =
  '请填写完整国际号码，以 + 和国家代码开头（如 +8613800138000），仅含数字，可含空格或连字符。';

/** 手机号填写提示：与 WhatsApp 同规则（均为「+ 国家代码」国际号码） */
export const PHONE_HINT = WHATSAPP_HINT;

/**
 * 创建 / 更新员工联系方式（同一 DTO，PUT 语义为「每个员工一条」）。
 *
 * 关键约束：
 *   · adminUserId 必须指向**真实存在且启用**的员工账号（防幽灵员工）
 *   · displayName 可登录邮箱不同（对外展示名 vs 登录邮箱）
 *   · displayEmail 与 adminUserId 的登录邮箱相互独立：展示邮箱可以另设
 *   · whatsapp / phone 均为「+ 国家代码」国际号码，彼此独立（可只填其一）
 *   · internalNote 绝不对外公开（公开接口不读该字段）
 */
export class UpsertContactDto {
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  adminUserId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  displayName!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(80)
  jobTitle?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEmail({}, { message: '展示邮箱格式不正确' })
  @MaxLength(120)
  displayEmail?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    // 未提供 / 空串 → undefined，交给 @IsOptional 跳过（表示「不修改/清空由 Service 处理」）
    if (trimmed === '') return undefined;
    const normalized = normalizeWhatsapp(trimmed);
    // 归一化失败 → **保留原值**，让后续 @Matches 报错。
    // 不能返回 null：@IsOptional 见到 null 会整段跳过校验，非法号码会被当成「未提供」。
    return normalized ?? trimmed;
  })
  @Matches(/^\+\d{8,15}$/, { message: WHATSAPP_HINT })
  @MaxLength(20)
  whatsapp?: string;

  /**
   * 对外展示手机号（可直接拨打）。
   * 与 whatsapp 同规则：只接受「+ 国家代码」国际号码，数字总长 8–15 位。
   * 二者相互独立：whatsapp 偏即时通讯，phone 偏语音通话，允许只填其一。
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    // 未提供 / 空串 → undefined，交给 @IsOptional 跳过（表示「不修改/清空由 Service 处理」）
    if (trimmed === '') return undefined;
    const normalized = normalizeWhatsapp(trimmed);
    // 归一化失败 → 保留原值，让后续 @Matches 报错
    return normalized ?? trimmed;
  })
  @Matches(/^\+\d{8,15}$/, { message: PHONE_HINT })
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  showOnSite?: boolean;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isLeadContact?: boolean;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  sortOrder?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  internalNote?: string | null;
}

/** 员工联系方式列表查询 */
export class ListContactsQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  keyword?: string;

  /** 仅看「询盘联系人」 */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isLeadContact?: boolean;

  /** 仅看「公开展示中」 */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  showOnSite?: boolean;

  /** 只看未绑定联系方式的员工（前端「补全联系方式」提示） */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  withoutContactOnly?: boolean;
}

export { toBool };
