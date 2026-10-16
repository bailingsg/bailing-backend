-- Phase 4.7：统一内容状态三态（DRAFT / PUBLISHED / ARCHIVED）
-- 并新增站点结构化内容（SiteSection）与站内导航（NavItem）。
--
-- 安全说明：
--   · ALTER TYPE ... ADD VALUE 在 PostgreSQL 12+ 可在事务内执行
--     （本迁移不在同一事务中使用新值，符合约束）。
--   · 既有数据不受影响：新枚举值只影响未来的状态流转。
--   · site_sections.mediaId 外键 ON DELETE SET NULL：
--     媒体被删除时分区的媒体引用置空（媒体删除保护另行拦截被引用场景）。

-- CreateEnum
CREATE TYPE "SitePage" AS ENUM ('HOME', 'ABOUT', 'CONTACT');

-- CreateEnum
CREATE TYPE "NavLocation" AS ENUM ('HEADER', 'FOOTER');

-- AlterEnum
ALTER TYPE "ContentStatus" ADD VALUE 'ARCHIVED';

-- AlterEnum
ALTER TYPE "PostStatus" ADD VALUE 'ARCHIVED';

-- CreateTable
CREATE TABLE "site_sections" (
    "id" TEXT NOT NULL,
    "page" "SitePage" NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "body" TEXT,
    "mediaId" TEXT,
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "stats" JSONB,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "site_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nav_items" (
    "id" TEXT NOT NULL,
    "location" "NavLocation" NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN DEFAULT true,
    "openInNewTab" BOOLEAN DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nav_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_sections_status_idx" ON "site_sections"("status");

-- CreateIndex
CREATE INDEX "site_sections_page_sortOrder_idx" ON "site_sections"("page", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "site_sections_page_sectionKey_key" ON "site_sections"("page", "sectionKey");

-- CreateIndex
CREATE INDEX "nav_items_location_isActive_sortOrder_idx" ON "nav_items"("location", "isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "site_sections" ADD CONSTRAINT "site_sections_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
