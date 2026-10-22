import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { normalizeWhatsapp, PHONE_HINT, WHATSAPP_HINT } from '../../cms/contacts/dto/contact.dto';

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 邮箱：允许空串（= 清空该展示字段），非空时必须是合法邮箱 */
const EMAIL_OR_EMPTY = /^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 自助修改「我的账号」资料（PATCH /auth/profile）。
 *
 * 与 CMS 侧 UpsertContactDto 的区别（刻意为之）：
 *   · **不需要 contacts.update 权限**——员工维护自己的信息属于自助行为，
 *     SALES 等角色只有 contacts.read，不应被迫走管理员改资料
 *   · **不能改** adminUserId / isLeadContact / sortOrder / internalNote：
 *     询盘分配与内部备注属于管理侧语义，员工自改会破坏分配公平与审计
 *   · 字段语义：**不传 = 不改**；传空串 = 清空该字段（仅展示类可选字段）
 *
 * 注意 email 是**登录邮箱**，修改后下次登录须使用新邮箱；
 * 展示邮箱（displayEmail）才是官网对外可见的地址。
 */
export class UpdateMyProfileDto {
  /** 姓名（后台内部显示） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: '姓名至少 2 个字符' })
  @MaxLength(50, { message: '姓名最多 50 个字符' })
  name?: string;

  /** 职位（后台内部显示；传空串 = 清空） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80, { message: '职位最多 80 个字符' })
  jobTitle?: string;

  /** 登录邮箱（全站唯一；修改后下次登录使用新邮箱） */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(EMAIL_OR_EMPTY, { message: '登录邮箱格式不正确' })
  @MaxLength(120)
  email?: string;

  /** 对外展示名（官网上显示的姓名） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: '展示名至少 2 个字符' })
  @MaxLength(50, { message: '展示名最多 50 个字符' })
  displayName?: string;

  /** 对外展示职位（可与后台职位不同；传空串 = 清空） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80, { message: '展示职位最多 80 个字符' })
  displayJobTitle?: string;

  /** 对外展示邮箱（与登录邮箱相互独立；传空串 = 清空） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(EMAIL_OR_EMPTY, { message: '展示邮箱格式不正确' })
  @MaxLength(120)
  displayEmail?: string;

  /** WhatsApp（+ 国家代码国际号码；传空串 = 清空） */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === '') return '';
    return normalizeWhatsapp(trimmed) ?? trimmed;
  })
  @Matches(/^$|^\+\d{8,15}$/, { message: WHATSAPP_HINT })
  @MaxLength(20)
  whatsapp?: string;

  /** 手机号（与 WhatsApp 同规则，相互独立；传空串 = 清空） */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === '') return '';
    return normalizeWhatsapp(trimmed) ?? trimmed;
  })
  @Matches(/^$|^\+\d{8,15}$/, { message: PHONE_HINT })
  @MaxLength(20)
  phone?: string;

  /** 是否在官网展示自己的联系方式 */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean({ message: 'showOnSite 必须为布尔值' })
  showOnSite?: boolean;
}
