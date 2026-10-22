-- 员工对外联系方式新增「手机号」字段（Phase 5.4 员工信息迁移）
-- 与 whatsapp 相互独立：whatsapp 偏即时通讯，phone 偏可直接拨打的语音号码。
-- 均为「+ 国家代码」国际号码（数字总长 8-15 位），数值校验在 DTO 层完成。
ALTER TABLE "employee_contacts" ADD COLUMN "phone" TEXT;
