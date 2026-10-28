-- 补齐角色权限的「查看」依赖（2026-10-28）
--
-- 背景：后台侧边栏入口与路由守卫都只认 `xxx.read`（admin/src/lib/route-permissions.ts），
-- 列表/详情接口同样要求 `xxx.read`。若只授予操作类权限（例如 rfq.update「跟进询盘状态」）
-- 而没给 rfq.read（「查看询盘」），账号既看不到菜单、直接输 URL 也会被拦，
-- 表现为「管理员分配了权限，员工账号里却没有这个页面」。
--
-- 处理：凡持有某模块任一非 read 权限、却缺少该模块 read 权限的角色，自动补上 read。
-- 只补 read（页面/接口的前提），不反向补操作权限，不改变任何既有授权范围。
-- 幂等：ON CONFLICT DO NOTHING；纯数据变更，不动表结构。

INSERT INTO "role_permissions" ("roleId", "permissionId", "createdAt")
SELECT DISTINCT
  rp."roleId",
  read_permission.id,
  NOW()
FROM "role_permissions" rp
JOIN "permissions" held
  ON held.id = rp."permissionId"
JOIN "permissions" read_permission
  ON read_permission.key = split_part(held.key, '.', 1) || '.read'
JOIN "roles" r
  ON r.id = rp."roleId"
WHERE split_part(held.key, '.', 2) <> 'read'
  AND r.key <> 'SUPER_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
