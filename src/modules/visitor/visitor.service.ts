import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeoIpResolver } from './geoip/geoip.resolver';
import { anonymizeIp } from './ip-anonymize';
import { normalizeIp } from './ip-normalize';
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
 *
 * 完整 IP 的唯一落点是 `visitor_ip_log`（见 `recordIpLog()`）：30 天保留、
 * 由 VisitorIpCleanupWorker 物理删除；`visitor_session` 仍只存脱敏网段。
 */
@Injectable()
export class VisitorService {
  private readonly logger = new Logger(VisitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoip: GeoIpResolver,
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
    const location = this.geoip.resolve(clientIp ?? '');
    const ua = userAgent ? userAgent.slice(0, 200) : null;

    // ③.5 IP 明细（「近期访客 IP」功能）：每次访问一条，与会话统计互不影响。
    //      放在限流之后、会话写入之前——超限的请求既不进明细也不进统计，
    //      两者口径保持一致。写入失败只丢明细，不影响下面的 UV/PV。
    await this.recordIpLog(clientIp, location.country, ua, now);

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

  /**
   * 写一条 IP 明细（访问级，不是会话级）。
   *
   * 与 visitor_session 的分工：那边存脱敏网段算 UV/PV，这边存完整 IP 供
   * 后台看「最近谁来过、来自哪个国家」，满 30 天由清理 worker 删除。
   *
   * 🔴 国家解析不出来就**整条不入库**（2026-10-28 业务要求）：
   *    后台只需要知道「客户来自哪个国家」，一条国家未知的 IP 对业务没有价值，
   *    却要多占一份个人信息（完整 IP）的存储与保留期风险。因此 `country` 为
   *    null 时直接 return，不写行。
   *    影响面：内网/保留网段（127.x / 192.168.x / 203.0.113.x 等）与未被国家库
   *    收录的地址不会出现在「近期访客 IP」里；国家分布也不会再有「未知」分组。
   *    ⚠️ 若 mmdb 加载失败（文件缺失/损坏），全站都会解析成 null → 整张表停止增长。
   *    这是**故意**的选择（宁可没有数据，也不存无法归因的 IP），排障时先看
   *    OfflineGeoIpResolver 的启动日志有没有「国家库加载失败」。
   *
   * 失败静默（规格 4.5）：明细表故障只是少一条 IP 记录，不能让整次上报失败，
   * 更不能连带丢掉 UV/PV。因此单独 try/catch，不与会话写入放同一事务。
   * 🔴 日志不得出现 IP（规格 10.4）。
   */
  private async recordIpLog(
    clientIp: string | null,
    country: string | null,
    userAgent: string | null,
    visitedAt: Date,
  ): Promise<void> {
    if (!clientIp) return;
    if (!country) return; // 国家未知 → 不入库
    const ip = normalizeIp(clientIp);
    if (!ip) return;
    try {
      await this.prisma.visitorIpLog.create({
        data: { ip, country, userAgent, visitedAt },
      });
    } catch {
      // 静默：明细表故障不影响会话统计
    }
  }
}
