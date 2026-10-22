-- 员工对外联系方式新增「头像」字段（Phase 5.4 员工信息迁移）
-- avatarKey   = StorageProvider 统一生成的对象键（与 media/ 同命名空间，COS/Local 通用）
-- avatarUrl   = provider 生成的访问地址快照（COS 场景即 CDN 域名）
-- 替换头像时：服务端上传新对象 → 落库 → 删除旧对象，保证存储中不残留孤儿文件。
ALTER TABLE "employee_contacts" ADD COLUMN "avatarKey" TEXT;
ALTER TABLE "employee_contacts" ADD COLUMN "avatarUrl" TEXT;
