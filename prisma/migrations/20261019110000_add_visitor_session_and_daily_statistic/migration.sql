-- 访客统计（匿名流量旁路模块，纯新增两张表，零外键）
--
-- 设计要点（与访客统计实现规格逐条对应）：
--   · visitor_session：一次会话一行的事实源。visitor_id 前端 UUID v4，
--     去重键，不对外返回；first_seen_at 为统计归属依据（UTC 日界），
--     跨天会话整条计入开始日；visit_count 使区间 PV 一次 SUM 可得；
--     masked_ip 为脱敏网段（IPv4 /24、IPv6 /48），完整 IP 不落库；
--     is_new_visitor = 该 visitorId 此前无任何会话。
--   · visitor_daily_statistic：读模型，一天一行，日聚合 worker 幂等
--     UPSERT；今日恒实时查事实源，本表仅供趋势图历史日读取。
--   · 时间列全部 TIMESTAMPTZ(3)，_DATE 列用 DATE；回滚只需 DROP 两张表。
--   · 本迁移一旦执行不得再改一个字节。

CREATE TABLE "visitor_session" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "visitCount" INTEGER NOT NULL DEFAULT 1,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "maskedIp" TEXT,
    "userAgent" TEXT,
    "isNewVisitor" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "visitor_session_first_seen_at_idx" ON "visitor_session"("firstSeenAt");
CREATE INDEX "visitor_session_visitor_id_last_seen_at_idx" ON "visitor_session"("visitorId", "lastSeenAt");
CREATE INDEX "visitor_session_country_first_seen_at_idx" ON "visitor_session"("country", "firstSeenAt");

CREATE TABLE "visitor_daily_statistic" (
    "id" TEXT NOT NULL,
    "statDate" DATE NOT NULL,
    "uniqueVisitors" INTEGER NOT NULL,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "newVisitors" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "visitor_daily_statistic_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "visitor_daily_statistic_stat_date_key" ON "visitor_daily_statistic"("statDate");
CREATE INDEX "visitor_daily_statistic_stat_date_idx" ON "visitor_daily_statistic"("statDate");
