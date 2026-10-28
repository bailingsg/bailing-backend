-- 访客 IP 明细表（「近期访客 IP」功能，2026-10-27，纯新增一张表，零外键）
--
-- 背景：原 visitor_session 按隐私红线只存脱敏网段（IPv4 /24、IPv6 /48），
-- 后台看不到具体 IP、也看不出访客来自哪个国家（GeoIP 一直是 Noop）。
-- 本表与 visitor_session **并存且分工明确**：
--   · visitor_session = 统计事实源（UV / PV / 会话），继续只存脱敏网段；
--   · visitor_ip_log  = 短期明细，存完整 IP 原文 + 国家代码，满 30 天删除。
-- 两者不含共同的 visitorId，不能拼出「某会话对应哪个 IP」的完整画像。
--
-- 设计要点：
--   · 每次 track 一条（访问级），写入受 VisitRateLimiter 双维度限流约束，
--     单网段 1200 次/分钟即本表写入速率上限；
--   · country 为 ISO 3166-1 alpha-2，由离线 GeoLite2-Country 库解析，
--     内网地址 / 未收录为 NULL（前端显示「未知」）；
--   · visited_at 为 TIMESTAMPTZ(3)，与 visitor_session 时间列口径一致；
--   · 索引：时间倒序分页、按 IP 回溯、按国家聚合；
--   · 保留期由 visitor-ip-cleanup.worker.ts 每日删除，SQL 层不设 TTL。
--   · 本迁移一旦执行不得再改一个字节。

CREATE TABLE "visitor_ip_log" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "country" TEXT,
    "userAgent" TEXT,
    "visitedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_ip_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "visitor_ip_log_visited_at_idx" ON "visitor_ip_log"("visitedAt" DESC);
CREATE INDEX "visitor_ip_log_ip_visited_at_idx" ON "visitor_ip_log"("ip", "visitedAt");
CREATE INDEX "visitor_ip_log_country_visited_at_idx" ON "visitor_ip_log"("country", "visitedAt");
