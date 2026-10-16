-- Phase 5.0：全站 SEO 基础设施
-- 新增表：seo_profiles（统一 SEO 档案）/ seo_settings（全局设置单例）/ seo_redirects（重定向）/ seo_audit_runs（审计记录）
-- media_assets 增加图片 SEO 字段：title / caption / description（altText 已存在）

-- CreateEnum
CREATE TYPE "SeoEntityType" AS ENUM ('PAGE', 'PRODUCT', 'PRODUCT_CATEGORY', 'BLOG_POST', 'BLOG_CATEGORY', 'APPLICATION', 'FACTORY_SECTION', 'QUALITY_RECORD');

-- CreateEnum
CREATE TYPE "SchemaType" AS ENUM ('NONE', 'WEB_PAGE', 'PRODUCT', 'ARTICLE', 'FAQ_PAGE');

-- CreateEnum
CREATE TYPE "SeoStatus" AS ENUM ('UNAUDITED', 'GOOD', 'NEEDS_IMPROVEMENT', 'POOR');

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "seo_profiles" (
    "id" TEXT NOT NULL,
    "entityType" "SeoEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "routePath" TEXT,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "canonicalUrl" TEXT,
    "robotsIndex" BOOLEAN NOT NULL DEFAULT true,
    "robotsFollow" BOOLEAN NOT NULL DEFAULT true,
    "focusKeyword" TEXT,
    "keywords" TEXT,
    "ogTitle" TEXT,
    "ogDescription" TEXT,
    "ogImage" TEXT,
    "twitterTitle" TEXT,
    "twitterDescription" TEXT,
    "twitterImage" TEXT,
    "schemaType" "SchemaType" NOT NULL DEFAULT 'NONE',
    "schemaData" JSONB,
    "relatedData" JSONB,
    "seoScore" INTEGER,
    "seoStatus" "SeoStatus" NOT NULL DEFAULT 'UNAUDITED',
    "lastAuditAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "siteName" TEXT NOT NULL DEFAULT 'Bailing Wooden',
    "siteTitle" TEXT,
    "siteDescription" TEXT,
    "defaultOgImage" TEXT,
    "defaultTwitterImage" TEXT,
    "canonicalDomain" TEXT,
    "pageTitleTemplate" TEXT NOT NULL DEFAULT '%title% | Bailing Wooden',
    "productTitleTemplate" TEXT NOT NULL DEFAULT '%title% | Bailing Wooden',
    "blogTitleTemplate" TEXT NOT NULL DEFAULT '%title% | Bailing Wooden',
    "categoryTitleTemplate" TEXT NOT NULL DEFAULT '%title% | Bailing Wooden',
    "companyName" TEXT,
    "companyLogo" TEXT,
    "companyWebsite" TEXT,
    "companyEmail" TEXT,
    "companyPhone" TEXT,
    "companyAddress" TEXT,
    "companyCountry" TEXT,
    "linkedin" TEXT,
    "facebook" TEXT,
    "instagram" TEXT,
    "youtube" TEXT,
    "whatsapp" TEXT,
    "googleSiteVerification" TEXT,
    "googleAnalyticsId" TEXT,
    "googleTagManagerId" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_redirects" (
    "id" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "targetPath" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_audit_runs" (
    "id" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "triggerType" TEXT NOT NULL DEFAULT 'MANUAL',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seo_audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seo_profiles_entityType_idx" ON "seo_profiles"("entityType");

-- CreateIndex
CREATE INDEX "seo_profiles_seoStatus_idx" ON "seo_profiles"("seoStatus");

-- CreateIndex
CREATE UNIQUE INDEX "seo_profiles_entityType_entityId_key" ON "seo_profiles"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "seo_redirects_sourcePath_key" ON "seo_redirects"("sourcePath");

-- CreateIndex
CREATE INDEX "seo_redirects_isActive_idx" ON "seo_redirects"("isActive");

-- CreateIndex
CREATE INDEX "seo_audit_runs_createdAt_idx" ON "seo_audit_runs"("createdAt");
