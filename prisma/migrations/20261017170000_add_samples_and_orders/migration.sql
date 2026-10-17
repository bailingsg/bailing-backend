-- Phase 5.1 样品管理 + Phase 5.2 订单管理
-- 样品：单仓库、持有人为创建人、业务三态 + OUT 归档态
-- 订单：金额 Decimal(14,2) 与币种分列、附件独立于媒体库

-- ---------- 样品 ----------
CREATE TYPE "SampleStatus" AS ENUM ('IN_STOCK', 'REQUEST_OUT', 'REJECTED', 'OUT');
CREATE TYPE "SampleRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

CREATE TABLE "samples" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT,
    "material" TEXT,
    "usage" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "remark" TEXT,
    "status" "SampleStatus" NOT NULL DEFAULT 'IN_STOCK',
    "ownerId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "samples_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sample_grants" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "granteeId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sample_requests" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "SampleRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sample_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "samples_code_key" ON "samples"("code");
CREATE INDEX "samples_ownerId_idx" ON "samples"("ownerId");
CREATE INDEX "samples_status_idx" ON "samples"("status");
CREATE INDEX "samples_createdAt_idx" ON "samples"("createdAt");
CREATE INDEX "sample_grants_sampleId_idx" ON "sample_grants"("sampleId");
CREATE INDEX "sample_grants_granteeId_revokedAt_idx" ON "sample_grants"("granteeId", "revokedAt");
CREATE INDEX "sample_requests_sampleId_status_idx" ON "sample_requests"("sampleId", "status");
CREATE INDEX "sample_requests_requesterId_idx" ON "sample_requests"("requesterId");
CREATE INDEX "sample_requests_ownerId_status_idx" ON "sample_requests"("ownerId", "status");

-- 防重复有效申请：同一样品同一时间只允许一个 PENDING 申请（数据库层兜底）
CREATE UNIQUE INDEX "sample_requests_one_pending_per_sample" ON "sample_requests"("sampleId") WHERE "status" = 'PENDING';

-- 防重复有效授权：同人同样品同一时间只允许一条有效授权
CREATE UNIQUE INDEX "sample_grants_one_active_per_pair" ON "sample_grants"("sampleId", "granteeId") WHERE "revokedAt" IS NULL;

ALTER TABLE "samples" ADD CONSTRAINT "samples_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sample_grants" ADD CONSTRAINT "sample_grants_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sample_grants" ADD CONSTRAINT "sample_grants_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sample_requests" ADD CONSTRAINT "sample_requests_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sample_requests" ADD CONSTRAINT "sample_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- 订单 ----------
CREATE TYPE "OrderCurrency" AS ENUM ('CNY', 'USD', 'EUR');

CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "salespersonId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" "OrderCurrency" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_attachments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "originalName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orders_code_key" ON "orders"("code");
CREATE INDEX "orders_salespersonId_idx" ON "orders"("salespersonId");
CREATE INDEX "orders_orderedAt_idx" ON "orders"("orderedAt");
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");
CREATE INDEX "order_attachments_orderId_idx" ON "order_attachments"("orderId");
CREATE INDEX "order_attachments_uploadedById_orderId_idx" ON "order_attachments"("uploadedById", "orderId");
CREATE UNIQUE INDEX "order_attachments_storageKey_key" ON "order_attachments"("storageKey");

ALTER TABLE "orders" ADD CONSTRAINT "orders_salespersonId_fkey" FOREIGN KEY ("salespersonId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
