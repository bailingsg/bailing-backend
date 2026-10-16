import { IsEnum, IsOptional } from 'class-validator';
import { NavLocation } from '@prisma/client';

/** 公开导航查询：位置必填（HEADER / FOOTER） */
export class ListPublicNavQueryDto {
  @IsOptional()
  @IsEnum(NavLocation)
  location?: NavLocation;
}
