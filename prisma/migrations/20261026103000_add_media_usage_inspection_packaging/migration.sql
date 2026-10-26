-- 质量页图集接入媒体库（2026-10-26）
--
-- 背景：「检验流程」「包装品质」两个图集此前在 api 模式下**没有任何数据源**——
--   /public/media 聚合只映射 FACTORY / PRODUCTION / LOADING / EXHIBITION，
--   而这两个分类只能靠 CMS 质量记录填充（质量记录并不产出图集），
--   结果两处永远渲染 3 个「照片待补充」占位。
--
-- 改动：MediaUsage 增加两个业务用途，使媒体库上传即能驱动质量页图集：
--   · INSPECTION  检验过程照片 → 前台质量页「检验流程」
--   · PACKAGING   包装品质照片 → 前台质量页「包装品质」
--
-- 纯增量（ADD VALUE），不动存量数据；CERTIFICATE 复用既有值，
-- 前台改为「无质量记录时以图片墙兜底」。
-- PostgreSQL 16：ADD VALUE 可在事务内执行，本迁移只新增取值、不在同事务内使用。

ALTER TYPE "MediaUsage" ADD VALUE IF NOT EXISTS 'INSPECTION';
ALTER TYPE "MediaUsage" ADD VALUE IF NOT EXISTS 'PACKAGING';
