-- 国家未知的访客 IP 不入库（2026-10-28 业务要求）
--
-- 背景：后台只关心「客户来自哪个国家」。一条国家解析不出来的 IP 对业务没有价值，
-- 却要多占一份个人信息（完整 IP）的存储与保留期风险，因此写入端直接跳过。
-- 这里把约束落到库上，防止将来有人绕过 service 直接 insert null。
--
-- 安全顺序：先清掉历史 null 行，再加 NOT NULL。本表 2026-10-27 才新建、尚未上线，
-- 生产无历史数据；本地若有测试行（保留网段如 203.0.113.0/24）会在此一并删除。

DELETE FROM "visitor_ip_log" WHERE "country" IS NULL;

ALTER TABLE "visitor_ip_log" ALTER COLUMN "country" SET NOT NULL;
