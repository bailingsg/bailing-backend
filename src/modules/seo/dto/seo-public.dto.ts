import { IsOptional, IsString, MaxLength } from 'class-validator';

/** 公开解析查询：paths 为逗号分隔的站内路径（最多 20 个，防滥用） */
export class PublicSeoResolveQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  paths?: string;
}
