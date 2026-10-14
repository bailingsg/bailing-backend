import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * POST /api/v1/auth/login 请求体。
 *
 * 与全局 ValidationPipe（whitelist + forbidNonWhitelisted）配合：
 * 未声明字段一律 400，防止把额外参数塞进认证入口。
 *
 * 注意：password 不做 trim 变换 —— 口令允许包含首尾空格，
 * 变换会导致用户无法使用包含空格的合法口令。
 */
export class LoginDto {
  /** 管理员邮箱（大小写不敏感，服务端统一转小写后比对） */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(160)
  email!: string;

  /** 口令（仅做长度约束，内容不变换） */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
