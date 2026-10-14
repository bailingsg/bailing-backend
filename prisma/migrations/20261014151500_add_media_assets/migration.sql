-- CreateEnum
CREATE TYPE "MediaCategory" AS ENUM ('IMAGE', 'DOCUMENT');

-- AlterTable（Phase 4.3 演扩：重命名 + 新增字段；media_assets 表 Phase 1 已建立且当前为空，零数据风险）
ALTER TABLE "media_assets" RENAME COLUMN "fileName" TO "filename";

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN "originalName" TEXT NOT NULL,
ADD COLUMN "width" INTEGER,
ADD COLUMN "height" INTEGER,
ADD COLUMN "category" "MediaCategory" NOT NULL DEFAULT 'IMAGE',
ADD COLUMN "createdBy" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storageKey_key" ON "media_assets"("storageKey");

-- CreateIndex
CREATE INDEX "media_assets_category_idx" ON "media_assets"("category");

-- CreateIndex
CREATE INDEX "media_assets_createdAt_idx" ON "media_assets"("createdAt");

-- CreateIndex
CREATE INDEX "media_assets_createdBy_idx" ON "media_assets"("createdBy");
