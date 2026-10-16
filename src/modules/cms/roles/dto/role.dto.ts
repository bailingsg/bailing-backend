import { RoleStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 空串 → undefined */
function emptyToUndefined({ value }: { value: unknown }): unknown {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/** 角色 key 规范：大写字母 / 数字 / 下划线，2–40 位 */
export const ROLE_KEY_REGEX = /^[A-Z][A-Z0-9_]{1,39}$/;
export const ROLE_KEY_MESSAGE =
  '角色标识需以大写字母开头，仅含大写字母、数字与下划线，长度 2–40 位（如 SALES_MANAGER）';

/**
 * 创建角色（POST /api/v1/cms/roles）。
 *
 * 说明：
 *   · 权限**不在创建时授予**，必须通过权限分配接口显式下发
 *     （避免表单忘记传权限时意外得到全部权限）
 *   · key 唯一性由 Service 校验并给出中文错误
 */
export class CreateRoleDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name!: string;

  @Transform(trim)
  @IsString()
  @Matches(ROLE_KEY_REGEX, { message: ROLE_KEY_MESSAGE })
  key!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  sortOrder?: number;
}

/** 更新角色（PATCH）——key 不可改（避免破坏审计与外部引用） */
export class UpdateRoleDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsEnum(RoleStatus)
  status?: RoleStatus;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  sortOrder?: number;
}

/**
 * 分配角色权限（PUT /api/v1/cms/roles/:id/permissions）。
 *
 * 语义：**全量替换**（传入的集合即最终权限集）。
 * 传空数组 = 清空该角色全部权限（合法操作，但需操作人具备 assign_permissions）。
 *
 * 安全：Service 会校验「操作人不得授予超出自身权限范围的权限」，
 *      即使前端已禁用复选框，也必须在后端拒绝伪造请求。
 */
export class AssignPermissionsDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  permissionKeys!: string[];
}

/** 角色列表查询 */
export class ListRolesQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  limit?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsEnum(RoleStatus)
  status?: RoleStatus;
}
