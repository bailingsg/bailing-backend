-- 询盘通知邮件投递状态（2026-10-27）
-- 目的：让后台能看到「哪条询盘的通知邮件没发出去」，并支持一键补发，
-- 避免 163 机房 IP 偶发 535 导致的通知静默丢失只能靠客户反馈才发现。
-- PENDING=待发送/未尝试, SENT=已发送, FAILED=重试后仍失败（可人工补发）。

CREATE TYPE "RfqNotifyStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

ALTER TABLE "rfqs"
  ADD COLUMN "notifyStatus"   "RfqNotifyStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "notifiedAt"     TIMESTAMP(3),
  ADD COLUMN "notifyError"    TEXT,
  ADD COLUMN "notifyAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "rfqs_notifyStatus_idx" ON "rfqs"("notifyStatus");
