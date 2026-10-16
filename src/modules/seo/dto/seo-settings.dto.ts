import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** 去首尾空白；空串保留（表示清空可空字段，服务层转 null） */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 更新 SEO 全局设置（PUT /cms/seo/settings，全部可选；未传字段不改动） */
export class UpdateSeoSettingsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  siteName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  siteTitle?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  siteDescription?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  defaultOgImage?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  defaultTwitterImage?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  canonicalDomain?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  pageTitleTemplate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  productTitleTemplate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  blogTitleTemplate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  categoryTitleTemplate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  companyName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  companyLogo?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  companyWebsite?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  companyEmail?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  companyPhone?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  companyAddress?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  companyCountry?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  linkedin?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  facebook?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  instagram?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  youtube?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  whatsapp?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  googleSiteVerification?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  googleAnalyticsId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  googleTagManagerId?: string;
}
