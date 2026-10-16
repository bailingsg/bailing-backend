import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

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
 * 创建员工账号（POST /api/v1/cms/accounts）。
 *
 * 口令规则：
 *   · 传 `initialPassword` → 使用该口令
 *   · 不传 → 由后端生成强随机口令，并在响应中一次性返回
 *   无论哪种方式，口令都不会以任何形式再次对外返回。
 *
 * 角色：
 *   · `roleIds` 至少 1 个（无角色账号登录后看不到任何功能，属于无效账号）
 *   · 后端会校验「操作人只能分配自己已有的角色」
 */
export class CreateAccountDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MaxLength(120)
  email!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(80)
  jobTitle?: string;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  roleIds!: string[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  initialPassword?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;
}

/** 更新账号（PATCH）——邮箱可改（需唯一），口令不在此接口修改 */
export class UpdateAccountDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  jobTitle?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  roleIds?: string[];
}

/** 启用 / 停用账号 */
export class SetAccountStatusDto {
  @Transform(toBool)
  @IsBoolean()
  isActive!: boolean;
}

/** 重置账号口令（管理员代操作）；不传则后端生成随机口令并一次性返回 */
export class ResetPasswordDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword?: string;
}

/** 账号列表查询 */
export class ListAccountsQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  limit?: number;

  /** 关键词：姓名 或 邮箱 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  keyword?: string;

  /** 按职位筛选 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  jobTitle?: string;

  /** 按角色 id 筛选 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  roleId?: string;

  /** 按账号状态筛选 */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;
}
