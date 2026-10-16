-- Phase 4.6：为 lead_assignments.assigneeId 补外键约束
--
-- 背景：20261015140000 建表时只建了普通索引，未声明关联关系，导致
--   1) 无法用 Prisma include 查询承接人姓名/邮箱；
--   2) 员工账号被删除后，询盘分配历史会留下悬空引用。
--
-- 策略：Restrict（禁止删除有分配历史的员工账号）。
--   询盘归属是销售历史资产，不允许随账号删除而静默消失；
--   本阶段也没有删除员工账号的接口，故不影响现有流程。
--
-- 安全守卫：若存在悬空 assigneeId（指向不存在的 admin_users），
-- 直接报错而不是清理数据——历史归属必须人工核实后处理。

DO $$
DECLARE
  dangling_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dangling_count
  FROM "lead_assignments" la
  LEFT JOIN "admin_users" au ON au."id" = la."assigneeId"
  WHERE au."id" IS NULL;

  IF dangling_count > 0 THEN
    RAISE EXCEPTION
      'lead_assignments 存在 % 条悬空 assigneeId（员工账号已不存在），请先人工核实分配历史',
      dangling_count;
  END IF;
END $$;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
