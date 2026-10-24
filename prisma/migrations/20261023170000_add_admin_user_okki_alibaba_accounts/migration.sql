-- 后台账号新增「小满账号 / 阿里账号」字段（内部备注用，均可空、非必填）
-- 小满（OKKI）CRM 与阿里巴巴平台的业务账号，便于内部知悉每个后台账号对应的平台身份。
ALTER TABLE "admin_users" ADD COLUMN "okkiAccount" TEXT;
ALTER TABLE "admin_users" ADD COLUMN "alibabaAccount" TEXT;
