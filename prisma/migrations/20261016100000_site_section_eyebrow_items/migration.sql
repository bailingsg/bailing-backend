-- Phase 4.7 补充：SiteSection 增加 eyebrow（小节眉题）与 items（结构化卡片数组）。
--
-- 背景：首页「核心能力 / 应用领域」与关于我们「理念 / 优势 / 方案」均为
-- {title, description} 卡片列表，需要结构化承载；仍为定式字段 +
-- DTO 白名单校验，不是页面构建器。

-- AlterTable
ALTER TABLE "site_sections" ADD COLUMN "eyebrow" TEXT,
ADD COLUMN "items" JSONB;
