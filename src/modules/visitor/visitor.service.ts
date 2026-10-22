import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NoopGeoIpResolver } from './geoip/geoip.resolver';
import { anonymizeIp } from './ip-anonymize';
import { isSessionContinued } from './session-window';
import { VisitRateLimiter } from './visit-rate-limiter';

/**
 * 访客会话追踪（访客统计实现规格第 4 节写入链路）。
 *
 * 口诀（每条都是红线，顺序不可调换）：
 *   ① 先脱敏（限流 key 与落库用）；
 *   ② 双维度限流，超限静默丢弃；
 *   ③ GeoIP 用**完整 IP** 解析，必须在截断之后调用本服务已拿到的原值，
 *      顺序反了城市级精度永久丢失；
 *   ④ 取该 visitorId 最近一条会话；
 *   ⑤ elapsed ≤ 30min 判延续（含时钟回拨的负 elapsed）；
 *   ⑥ 否则新建会话，is_new_visitor = 此前无任何会话。
 *
 * 隐私红线（规格 10.4）：本类日志只允许「访客上报处理失败」这类无参消息，
 * 禁止出现完整 IP / maskedIp / visitorId / 限流 key / UA。
 */
@Injectable()
export class VisitorService {
  private readonly logger = new Logger(VisitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoip: NoopGeoIpResolver,
    private readonly rateLimiter: VisitRateLimiter,
  ) {}

  /**
   * 记录一次匿名访问。任何异常在此处被吞掉（调用方恒返回 200），
   * 统计是旁路能力，坏了不能影响用户浏览（规格 4.5）。
   */
  async track(visitorId: string, clientIp: string | null, userAgent: string | null): Promise<void> {
    try {
      await this.record(visitorId, clientIp, userAgent);
    } catch (error) {
      // 日志不得含 ip / visitorId / UA（规格 10.4）
      this.logger.warn(
        `访客上报处理失败（已静默忽略）：${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  private async record(
    visitorId: string,
    clientIp: string | null,
    userAgent: string | null,
  ): Promise<void> {
    const now = new Date();

    // ① 脱敏（仅用于限流 key 与落库）
    const maskedIp = anonymizeIp(clientIp);

    // ② 双维度限流：任一超限 ⇒ 静默丢弃（不返回 429）
    if (!this.rateLimiter.tryConsume(visitorId, maskedIp, now.getTime())) {
      return;
    }

    // ③ GeoIP 必须在 IP 截断之前用完整 IP 解析（规格 4.3 红线 1）。
    //    当前为 Noop 解析器（country/city 恒 null，前端显示「未知」）。
    const location = this.geoip.resolve(clientIp ?? '');
    const ua = userAgent ? userAgent.slice(0, 200) : null;

    // ④ 取该 visitorId 最近一条会话（索引 visitor_session(visitor_id, last_seen_at)）
    const latest = await this.prisma.visitorSession.findFirst({
      where: { visitorId },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        lastSeenAt: true,
        country: true,
        region: true,
        city: true,
        maskedIp: true,
        userAgent: true,
      },
    });

    // ⑤ 会话延续：只补空缺，绝不用新值覆盖已有值（规格 4.3 红线 3——
    //    移动端会话中途换网络也不能让一条会话统计成两个地区）
    if (latest && isSessionContinued(latest.lastSeenAt, now)) {
      await this.prisma.visitorSession.update({
        where: { id: latest.id },
        data: {
          lastSeenAt: now,
          visitCount: { increment: 1 },
          country: latest.country ?? location.country,
          region: latest.region ?? location.region,
          city: latest.city ?? location.city,
          maskedIp: latest.maskedIp ?? maskedIp,
          userAgent: latest.userAgent ?? ua,
        },
      });
      return;
    }

    // ⑥ 新建会话：is_new_visitor = 该 visitorId 此前无任何会话
    //    （不是「今天第一次来」，规格 2.5 / 坑 4）
    await this.prisma.visitorSession.create({
      data: {
        visitorId,
        firstSeenAt: now,
        lastSeenAt: now,
        visitCount: 1,
        country: location.country,
        region: location.region,
        city: location.city,
        maskedIp,
        userAgent: ua,
        isNewVisitor: latest === null,
      },
    });
  }
}
