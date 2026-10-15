-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "FactorySectionType" AS ENUM ('OVERVIEW', 'FACILITY', 'EQUIPMENT', 'PRODUCTION', 'LOADING', 'EXHIBITION');

-- CreateEnum
CREATE TYPE "QualityRecordType" AS ENUM ('CERTIFICATION', 'TEST_REPORT', 'QUALITY_CONTROL', 'STANDARD');

-- CreateTable
CREATE TABLE "factory_sections" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sectionType" "FactorySectionType" NOT NULL,
    "summary" TEXT,
    "content" TEXT,
    "coverMediaId" TEXT,
    "coverImageUrl" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "factory_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "factory_images" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "exhibitionId" TEXT,
    "altText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "factory_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "factory_exhibitions" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "heldOn" TIMESTAMP(3),
    "location" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "factory_exhibitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_records" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "recordType" "QualityRecordType" NOT NULL,
    "issuer" TEXT,
    "certificateNumber" TEXT,
    "issueDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "description" TEXT,
    "mediaId" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "summary" TEXT,
    "description" TEXT,
    "coverMediaId" TEXT,
    "coverImageUrl" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_products" (
    "applicationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_products_pkey" PRIMARY KEY ("applicationId","productId")
);

-- CreateIndex
CREATE UNIQUE INDEX "factory_sections_slug_key" ON "factory_sections"("slug");

-- CreateIndex
CREATE INDEX "factory_sections_status_idx" ON "factory_sections"("status");

-- CreateIndex
CREATE INDEX "factory_sections_sectionType_idx" ON "factory_sections"("sectionType");

-- CreateIndex
CREATE INDEX "factory_sections_sortOrder_idx" ON "factory_sections"("sortOrder");

-- CreateIndex
CREATE INDEX "factory_sections_publishedAt_idx" ON "factory_sections"("publishedAt");

-- CreateIndex
CREATE INDEX "factory_sections_coverMediaId_idx" ON "factory_sections"("coverMediaId");

-- CreateIndex
CREATE INDEX "factory_images_sectionId_idx" ON "factory_images"("sectionId");

-- CreateIndex
CREATE INDEX "factory_images_exhibitionId_idx" ON "factory_images"("exhibitionId");

-- CreateIndex
CREATE INDEX "factory_images_mediaId_idx" ON "factory_images"("mediaId");

-- CreateIndex
CREATE INDEX "factory_exhibitions_sectionId_idx" ON "factory_exhibitions"("sectionId");

-- CreateIndex
CREATE INDEX "factory_exhibitions_heldOn_idx" ON "factory_exhibitions"("heldOn");

-- CreateIndex
CREATE UNIQUE INDEX "quality_records_slug_key" ON "quality_records"("slug");

-- CreateIndex
CREATE INDEX "quality_records_status_idx" ON "quality_records"("status");

-- CreateIndex
CREATE INDEX "quality_records_recordType_idx" ON "quality_records"("recordType");

-- CreateIndex
CREATE INDEX "quality_records_sortOrder_idx" ON "quality_records"("sortOrder");

-- CreateIndex
CREATE INDEX "quality_records_publishedAt_idx" ON "quality_records"("publishedAt");

-- CreateIndex
CREATE INDEX "quality_records_mediaId_idx" ON "quality_records"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "applications_slug_key" ON "applications"("slug");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE INDEX "applications_featured_idx" ON "applications"("featured");

-- CreateIndex
CREATE INDEX "applications_sortOrder_idx" ON "applications"("sortOrder");

-- CreateIndex
CREATE INDEX "applications_publishedAt_idx" ON "applications"("publishedAt");

-- CreateIndex
CREATE INDEX "applications_coverMediaId_idx" ON "applications"("coverMediaId");

-- CreateIndex
CREATE INDEX "application_products_productId_idx" ON "application_products"("productId");

-- AddForeignKey
ALTER TABLE "factory_sections" ADD CONSTRAINT "factory_sections_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_images" ADD CONSTRAINT "factory_images_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "factory_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_images" ADD CONSTRAINT "factory_images_exhibitionId_fkey" FOREIGN KEY ("exhibitionId") REFERENCES "factory_exhibitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_images" ADD CONSTRAINT "factory_images_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_exhibitions" ADD CONSTRAINT "factory_exhibitions_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "factory_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_records" ADD CONSTRAINT "quality_records_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_products" ADD CONSTRAINT "application_products_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_products" ADD CONSTRAINT "application_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

