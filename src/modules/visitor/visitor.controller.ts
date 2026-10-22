import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { TrackVisitorDto } from './dto/track-visitor.dto';
import { VisitorService } from './visitor.service';

/**
 * 访客上报端点（访客统计实现规格 4.1）。
 *
 *   POST /api/v1/visitor/track   （无认证，公开，覆盖未登录流量）
 *
 * 契约硬约束：
 *   · 成功**恒为** 200 { "success": true }（SkipTransform 保证响应体只有这一个键，
 *     可被 TransformInterceptor 之外的唯一登记例外）；
 *   · 失败也恒 200（规格 4.5 失败静默）——数据库不可用 / GeoIP 异常 /
 *     限流器异常一律吞掉；
 *   · 响应不得包含计数 / 记录 ID / 时间戳 / isNewVisitor / 任何数据库信息，
 *     否则上报端点会变成可探测的「统计查询接口」。
 *
 * 客户端 IP（规格 4.6）：线上经 nginx 反代，trust proxy = 1 时 req.ip 已按
 * X-Forwarded-For 回推一跳；取最左非空值、剥离 IPv4-mapped 与 zone id
 * 由 anonymizeIp 负责。req.ip 为 undefined 时按 null 处理（脱敏返回 null，
 * 不影响会话记录，仅 GeoIP 与限流退化）。
 */
@Controller('visitor')
export class VisitorController {
  constructor(private readonly visitorService: VisitorService) {}

  @Post('track')
  @SkipTransform()
  @HttpCode(HttpStatus.OK) // 规格 4.1：成功状态码恒为 200（@Post 默认 201）
  async track(@Body() dto: TrackVisitorDto, @Req() request: Request): Promise<{ success: true }> {
    const clientIp = firstForwardedIp(request) ?? request.ip ?? null;
    const userAgent = headerToString(request.headers['user-agent']);
    await this.visitorService.track(dto.visitorId, clientIp, userAgent);
    // 恒 200，不带任何其它字段（含失败路径，见 VisitorService.track 的吞错）
    return { success: true };
  }
}

/** X-Forwarded-For 形如 `client, proxy1, proxy2`，取最左非空值 */
function firstForwardedIp(request: Request): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/** UA 头取字符串值（数组取首个；null → null） */
function headerToString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
