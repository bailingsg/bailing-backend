-- Phase 3.7：RFQ 询盘系统
--
-- 本迁移为**纯新增 + 清理未使用的占位表**，不改动任何历史迁移：
--   1) 新增 RfqStatus 枚举与 rfqs 表（RFQ 询盘实体）
--   2) 移除 Phase 1 建立但从未使用的 Inquiry 占位模型（inquiries 表无任何写入路径，
--      其职责由 rfqs 承接）。若未来需要保留该表，可在本迁移中删除对应的 DROP 语句。
--
-- SQL 由 `prisma migrate diff`（datamodel → datamodel，离线）生成，未使用 db push / migrate reset。

-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('NEW', 'CONTACTED', 'QUOTED', 'CLOSED');

-- DropForeignKey
ALTER TABLE "inquiries" DROP CONSTRAINT "inquiries_productId_fkey";

-- DropTable
DROP TABLE "inquiries";

-- DropEnum
DROP TYPE "InquiryStatus";

-- CreateTable
CREATE TABLE "rfqs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "country" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT,
    "message" TEXT NOT NULL,
    "quantity" TEXT,
    "attachmentUrl" TEXT,
    "status" "RfqStatus" NOT NULL DEFAULT 'NEW',
    "sourceIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rfqs_status_idx" ON "rfqs"("status");

-- CreateIndex
CREATE INDEX "rfqs_createdAt_idx" ON "rfqs"("createdAt");

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
