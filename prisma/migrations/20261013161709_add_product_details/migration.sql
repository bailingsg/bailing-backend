-- Phase 3.5: Products 产品中心 —— 产品实体扩展
--
-- 变更内容：
--   1. products.summary 重命名为 shortDescription（列表页短描述）
--   2. products 新增 material / application / specifications(jsonb) 字段
--   3. 新增 product_images 表（产品图片，一对多，仅登记 URL，不绑定存储服务）
--   4. 新增 products.isFeatured 索引
--
-- 说明：不含任何电商字段（price / stock / sku / cart / payment）；
--       本次为增量迁移，不修改历史迁移、不 reset 数据库。

-- AlterTable：重命名列（保留既有数据）
ALTER TABLE "products" RENAME COLUMN "summary" TO "shortDescription";

-- AlterTable：新增产品详情字段
ALTER TABLE "products"
ADD COLUMN "material" TEXT,
ADD COLUMN "application" TEXT,
ADD COLUMN "specifications" JSONB;

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_images_productId_idx" ON "product_images"("productId");

-- CreateIndex
CREATE INDEX "products_isFeatured_idx" ON "products"("isFeatured");

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
