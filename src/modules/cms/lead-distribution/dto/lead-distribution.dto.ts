import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function emptyToUndefined({ value }: { value: unknown }): unknown {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/** 单个倾斜计划员工的条目 */
export class PlanItemDto {
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  adminUserId!: string;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100000)
  targetCount!: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

/**
 * 创建倾斜计划（POST /api/v1/cms/lead-distribution/plans）。
 *
 * 约束：
 *   · 同一时间只允许**一个** ACTIVE 计划（Service 校验，避免两条计划同时抢询盘）
 *   · 员工必须是系统中真实存在且当前可分配的账号（防幽灵员工）
 *   · 冷却秒数默认 0 = 手动关闭后需管理员显式恢复；>0 = 冷却结束自动恢复
 */
export class CreatePlanDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  /**
   * 倾斜员工条目。
   *
   * 注意：**不能**用 @ArrayUnique() / @IsString({each:true})——前者对对象数组比的是引用
   * （同一员工的两个 JSON 对象永远不相等），后者则直接判对象为非法字符串。
   * 重复员工由 Service 层按 adminUserId 校验。
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PlanItemDto)
  items!: PlanItemDto[];

  /** 手动关闭后的冷却秒数（0 = 仅允许手动恢复） */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(86400 * 30)
  cooldownSeconds?: number;

  /** 计划截止时间（可选；不传则按目标数量自然完成） */
  @IsOptional()
  @IsString()
  startAt?: string;

  @IsOptional()
  @IsString()
  endAt?: string;
}

/** 调整进行中计划的员工与目标数量（PATCH） */
export class UpdatePlanDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  /** 调整后的员工条目（整表替换；重复员工由 Service 按 adminUserId 校验） */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PlanItemDto)
  items!: PlanItemDto[];

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(86400 * 30)
  cooldownSeconds?: number;

  @IsOptional()
  @IsString()
  endAt?: string | null;
}

/** 手动关闭计划 */
export class ClosePlanDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** 询盘分配列表查询 */
export class ListAssignmentsQueryDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** 按承接人筛选 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  assigneeId?: string;

  /** 按来源筛选：ROUND_ROBIN / PRIORITY_PLAN */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  source?: string;
}

/** 计划操作历史查询 */
export class ListPlanLogsQueryDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

export { toInt };
