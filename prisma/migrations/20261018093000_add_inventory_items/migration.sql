-- Phase 5.3：库存管理（inventory_items）
--
-- 设计要点：
--   · quantity 使用 Decimal(14,3)（非负、最多三位小数），避免二进制浮点精度误差；
--   · orderId 可空：库存可不关联订单；订单号从关联订单实时读取，不冗余副本；
--   · orderId 外键 ON DELETE RESTRICT：删除/归档订单不得级联删除库存记录
--     （当前系统无整单删除端点，双保险）；
--   · createdById 外键 ON DELETE RESTRICT：删除账号不得级联删除库存；
--   · code 为系统生成的库存编号，全局唯一；
--   · orders.code 的唯一索引 "orders_code_key" 在
--     20261017170000_add_samples_and_orders 中已建立（精确匹配、区分大小写），
--     本阶段订单号改由业务员手动填写，仅沿用该约束，无结构变更。

CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productDetail" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "storedAt" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_items_code_key" ON "inventory_items"("code");
CREATE INDEX "inventory_items_createdById_idx" ON "inventory_items"("createdById");
CREATE INDEX "inventory_items_orderId_idx" ON "inventory_items"("orderId");
CREATE INDEX "inventory_items_productName_idx" ON "inventory_items"("productName");
CREATE INDEX "inventory_items_storedAt_idx" ON "inventory_items"("storedAt");
CREATE INDEX "inventory_items_createdAt_idx" ON "inventory_items"("createdAt");

ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
