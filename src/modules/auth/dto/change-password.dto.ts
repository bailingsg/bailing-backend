import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 自助修改口令（POST /auth/change-password）。
 *
 * 与 LoginDto 一致：**不对口令做 trim 变换**——口令允许首尾空格，
 * 变换会让「注册时含空格的口令」永远对不上。
 *
 * 长度：bcrypt 只取前 72 字节，故上限 72 与账号创建/重置保持同一口径；
 * 下限 8 位与 CreateAccountDto.initialPassword 一致。
 */
export class ChangePasswordDto {
  /** 当前口令（用于二次确认身份，防止借用未锁屏的会话改密码） */
  @IsString()
  @MinLength(1, { message: '请输入当前口令' })
  @MaxLength(128)
  currentPassword!: string;

  /** 新口令 */
  @IsString()
  @MinLength(8, { message: '新口令至少 8 位' })
  @MaxLength(72, { message: '新口令最多 72 位' })
  newPassword!: string;
}
