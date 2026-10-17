-- CreateEnum
CREATE TYPE "ContentEntityType" AS ENUM ('PRODUCT', 'BLOG_POST', 'FACTORY_SECTION', 'QUALITY_RECORD', 'APPLICATION', 'SITE_SECTION');

-- CreateEnum
CREATE TYPE "ContentRevisionAction" AS ENUM ('PUBLISH', 'UNPUBLISH');

-- AlterEnum
ALTER TYPE "ContentStatus" ADD VALUE 'UNPUBLISHED';

-- AlterEnum
ALTER TYPE "PostStatus" ADD VALUE 'UNPUBLISHED';

-- AlterEnum
ALTER TYPE "ProductStatus" ADD VALUE 'UNPUBLISHED';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "publishedVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "blog_posts" ADD COLUMN     "publishedVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "factory_sections" ADD COLUMN     "publishedVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "publishedVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "quality_records" ADD COLUMN     "publishedVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "site_sections" ADD COLUMN     "publishedVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "content_drafts" (
    "id" TEXT NOT NULL,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "baseVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_revisions" (
    "id" TEXT NOT NULL,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "action" "ContentRevisionAction" NOT NULL DEFAULT 'PUBLISH',
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "content_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_drafts_entityType_updatedAt_idx" ON "content_drafts"("entityType", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "content_drafts_entityType_entityId_key" ON "content_drafts"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "content_revisions_entityType_entityId_publishedAt_idx" ON "content_revisions"("entityType", "entityId", "publishedAt");

-- CreateIndex
CREATE INDEX "content_revisions_publishedAt_idx" ON "content_revisions"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "content_revisions_entityType_entityId_version_key" ON "content_revisions"("entityType", "entityId", "version");

