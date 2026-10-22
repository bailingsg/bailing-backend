import { IsIn } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 趋势查询参数（访客统计实现规格 5.2）。
 *
 * 🔴 days 白名单只有 7 / 30：开放任意天数会让 days=100000 触发
 * 上万次实时聚合（资源放大攻击面）；其它值一律 400，不静默回退。
 */
export class VisitorTrendQueryDto {
  @IsIn([7, 30], { message: 'days 只接受 7 或 30' })
  @Type(() => Number)
  days!: 7 | 30;
}
