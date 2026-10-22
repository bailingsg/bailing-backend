-- Phase 5.6：媒体用途分类 + 文章关联产品
--
-- 1) MediaUsage：媒体库「用途」分类（文章 / 产品 / 证书 / 工厂 / 生产 / 装车 / 展会 /
--    应用场景 / 站点配图 / 其他），与既有 category（IMAGE / DOCUMENT 文件类型）正交。
--    可空 = 未分类：存量历史图不强制回溯标注。
-- 2) blog_post_products：文章 ↔ 产品 关联（上限 4 由应用层校验），
--    显式 join 表便于级联删除与反查，sortOrder 决定前台展示顺序。

-- CreateEnum
CREATE TYPE "MediaUsage" AS ENUM ('BLOG', 'PRODUCT', 'CERTIFICATE', 'FACTORY', 'PRODUCTION', 'LOADING', 'EXHIBITION', 'APPLICATION', 'SITE', 'OTHER');

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN "usage" "MediaUsage";

-- CreateIndex
CREATE INDEX "media_assets_usage_idx" ON "media_assets"("usage");

-- CreateTable
CREATE TABLE "blog_post_products" (
    "postId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_post_products_pkey" PRIMARY KEY ("postId","productId")
);

-- CreateIndex
CREATE INDEX "blog_post_products_productId_idx" ON "blog_post_products"("productId");

-- AddForeignKey
ALTER TABLE "blog_post_products" ADD CONSTRAINT "blog_post_products_postId_fkey" FOREIGN KEY ("postId") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_post_products" ADD CONSTRAINT "blog_post_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
