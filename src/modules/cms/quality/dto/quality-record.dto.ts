import { QualityRecordType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SLUG_MESSAGE, SLUG_REGEX } from '../../../../common/validators/slug';

/** 去首尾空白 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 数值宽松解析：空串视为未提供 */
function toInt({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '' || value === null) return undefined;
  return Number(value);
}

/** 空串 → undefined（可选字段统一语义，避免把 '' 写入数据库） */
function emptyToUndefined({ value }: { value: unknown }): unknown {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/**
 * 创建质量记录（POST /api/v1/cms/quality）。
 *
 * 数据诚实约束：
 *   · issuer / certificateNumber / issueDate / expiryDate **全部可选**——
 *     QUALITY_CONTROL 类记录通常没有证书编号与有效期，不得强制填假值。
 *   · 日期一律为业务真实日期，不做「缺失即推断」。
 *
 * 校验分工：
 *   · DTO 负责格式、枚举、长度
 *   · mediaId 的**存在性**由 Service 校验（返回 400）
 */
export class CreateQualityRecordDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  @MaxLength(200)
  slug!: string;

  @IsEnum(QualityRecordType)
  recordType!: QualityRecordType;

  /** 认证 / 检测机构（可空） */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(200)
  issuer?: string;

  /** 证书编号（可空；无证书的记录留空即可） */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(120)
  certificateNumber?: string;

  /** 颁发日期（可空） */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  issueDate?: string;

  /** 到期日期（可空；空 ≠ 已过期） */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  expiryDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20000)
  description?: string;

  /** 证书图片 / PDF 的媒体 ID（可空） */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(64)
  mediaId?: string;

  // Phase 1：Create DTO 不接受 status / publishedAt（新建恒为 DRAFT）

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  seoTitle?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  seoDescription?: string;
}

/**
 * 更新质量记录（PATCH）。
 *
 * 日期字段显式传 null 表示清空（Service 侧处理 null 语义）；
 * 不传表示保持不变。**不会因为「传了字段但为空」就写入错误日期。**
 */
export class UpdateQualityRecordDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  @MaxLength(200)
  slug?: string;

  @IsOptional()
  @IsEnum(QualityRecordType)
  recordType?: QualityRecordType;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  issuer?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  certificateNumber?: string | null;

  @IsOptional()
  @IsISO8601()
  issueDate?: string | null;

  @IsOptional()
  @IsISO8601()
  expiryDate?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  mediaId?: string | null;

  // Phase 1：Update DTO 不接受 status / publishedAt（发布态只能经 publish/unpublish 变更）

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  seoTitle?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  seoDescription?: string;
}
