# Phase 4.6 Final Report

> 百灵木业 CMS —— 账号管理 + 自定义角色权限 + 员工联系方式 + 询盘轮询计划
> 完成日期：2026-10-16 · 分支：`261016`（backend / admin 双侧一致）

---

## A. 完成状态

| # | 任务 | 状态 |
| --- | --- | --- |
| 51 | 询盘分配引擎（含数据模型核对与追加迁移） | ✅ |
| 52 | RFQ 创建集成（事务内自动分配，幂等，不破坏 X-Admin-Token） | ✅ |
| 53 | 生产构建 + 真实服务联调（含重启后指针持久化实测） | ✅ |
| 54 | Admin 四模块中文界面（9 条新路由） | ✅ |
| 55 | 浏览器 E2E（62/62）+ 文档 + Git 推送 | ✅ |

**硬约束遵守情况**：#45–#50 已完成工作零回滚；未重跑历史迁移、未重建数据模型
（3 个迁移全部为追加式）；全程 Prisma 6 + PostgreSQL（无 SQLite / Drizzle）；
轮询指针持久化在数据库单行表（非 UI、非内存变量）；所有「测试通过」结论均来自
本次实际运行的结果。

---

## B. 实际修改的仓库及文件

### bailing-backend（commit `4ba9513`，57 files）

**修改（26）**
- `prisma/schema.prisma` — 新增 3 枚举 + 8 模型；`AdminUser.jobTitle`；`Rfq.assigneeId/assignedAt`；
  `LeadAssignment.assignee` 关系 + `AdminUser.leadAssignments` 反向关系
- `prisma/seed.ts`、`prisma/seed-rbac.ts`（新）— 角色 / 权限 / 超管绑定初始化
- `src/app.module.ts` — 注册 RbacModule
- `src/modules/auth/auth.dto.ts`、`auth.service.ts` — `/auth/me` 返回 roles / permissions / isSuperAdmin / jobTitle
- `src/modules/cms/cms.module.ts` — 注册 Accounts / Roles / Contacts / LeadDistribution 模块
- `src/modules/cms/{applications,blog×3,cms,factory,products,quality,media}.controller.ts` —
  controller 级 `@UseGuards(JwtAuthGuard, PermissionsGuard)` + `@RequirePermissions(...)`
- `src/modules/public/public.module.ts` — 挂载公开联系方式控制器
- `src/modules/rfq/rfq.service.ts`、`rfq.module.ts`、`rfq.dto.ts`、`dto/list-rfq-query.dto.ts` —
  创建事务内自动分配；列表/详情返回承接人；支持 assigneeId / assigned 筛选
- `jest.config.js` — `maxWorkers: 1`（多套件共享同一 PostgreSQL，并行会偶发计数抖动）
- `test/auth.spec.ts`、`test/rfq.spec.ts` — 适配 RbacService mock 与 `$transaction` 回调形态

**新增**
- `src/modules/rbac/`：`permission.registry.ts`（42 项权限注册表，唯一事实源）、
  `permissions.guard.ts`、`require-permissions.decorator.ts`、`rbac.service.ts`、
  `audit-log.service.ts`、`actor-context.ts`、`rbac.module.ts`
- `src/modules/cms/accounts/`（service / controller / dto / entities / module）
- `src/modules/cms/roles/`（同上）
- `src/modules/cms/contacts/`（同上）
- `src/modules/cms/lead-distribution/`（service ~1180 行 / controller / dto / entities / module）
- `src/modules/public/public-contacts.controller.ts` — 公开只读联系方式（无 internalNote / loginEmail）
- `prisma/migrations/` ×3（见 C）
- `test/lead-distribution.e2e-spec.ts`（14 用例，真实 PostgreSQL）

### bailing-admin（commit `121a7ad`，32 files，+5000/−35）

**修改（3）**：`src/app/(dashboard)/layout.tsx`（侧边栏按权限渲染）、
`src/components/admin-sidebar.tsx`（导航权限化 + 4 个新入口）、`src/lib/api.ts`
（AdminProfile 增加 roles / permissions / isSuperAdmin / jobTitle + hasPermission 助手）

**新增**
- `src/components/ui/modal.tsx` — Modal / FormField / ProgressBar 基础组件
- `src/lib/rbac.ts`、`src/lib/lead-distribution.ts` — API 客户端（服务端 Action 转发 JWT）
- `src/app/(dashboard)/accounts/`：`page.tsx`、`new/page.tsx`、`[id]/edit/page.tsx`、
  `account-form.tsx`、`account-status-button.tsx`（两步确认）、`reset-password-button.tsx`、`actions.ts`
- `src/app/(dashboard)/roles/`：`page.tsx`、`[id]/page.tsx`、`[id]/permission-editor.tsx`、
  `role-form-modal.tsx`、`delete-role-button.tsx`、`actions.ts`
- `src/app/(dashboard)/contacts/`：`page.tsx`、`contact-form-modal.tsx`、
  `visibility-button.tsx`、`delete-contact-button.tsx`、`actions.ts`
- `src/app/(dashboard)/lead-distribution/`：`page.tsx`、`history/page.tsx`、`[id]/page.tsx`、
  `plan-action-button.tsx`、`create-plan-modal.tsx`、`plan-progress-modal.tsx`、
  `[id]/plan-actions.tsx`、`actions.ts`

### bailing-ui

本阶段**未修改**。仓库内现存一批未提交的设计系统改造（globals.css / layout / page /
site-header / site-footer / badge / button，Phase 3.2 收尾性质），与本阶段无关，未触碰、未提交。

---

## C. 数据库模型及 Migration

3 个追加式迁移（先 `migrate diff` 生成 → 手写 SQL → `migrate deploy` → 零漂移复核）：

| 迁移 | 内容 |
| --- | --- |
| `20261015140000_add_rbac_accounts_contacts_lead_distribution` | 枚举 `RoleStatus`/`LeadPlanStatus`/`LeadAssignmentSource`；表 `roles`/`permissions`/`role_permissions`/`admin_user_roles`/`employee_contacts`/`lead_distribution_plans`/`lead_distribution_items`/`lead_assignments`/`audit_logs`；`admin_users.jobTitle`；`rfqs.assigneeId/assignedAt` |
| `20261015150000_add_lead_round_robin_state` | 表 `lead_round_robin_state`（单行指针，id 固定 `round-robin`） |
| `20261015160000_add_lead_assignment_assignee_fk` | `lead_assignments.assigneeId → admin_users.id`（ON DELETE RESTRICT）外键；迁移前先校验无悬挂数据 |

- `migrate status`：10+ migrations，up to date；`migrate diff` 复检为空迁移（零漂移）。
- 全部为**增量**：未改历史迁移、未 reset、未 push schema。
- 种子角色：`SUPER_ADMIN`（受保护）、`CONTENT_EDITOR`、`SALES`；权限共 42 项
  （写操作为功能权限，各模块 `.read` 与导航入口绑定为导航权限）。

---

## D. RBAC 设计

- **唯一事实源**：`AdminUserRole` 多对多；旧 `AdminUser.role` 枚举仅作兼容保留。
- **双 Guard**：`JwtAuthGuard`（passport-jwt）验签 → `PermissionsGuard` **每次请求实时查库**
  校验权限与账号状态（401 / 403 且指明缺失权限）；RFQ 后台三接口仍走 `AdminTokenGuard`
  （`x-admin-token` + `timingSafeEqual`），兼容性未动。
- **遗留回落**：零角色绑定的账号按旧枚举映射（ADMIN→超管全集；EDITOR→CONTENT_EDITOR），
  未迁移账号保持 4.6 前行为；只要存在任一绑定（含停用角色）即按显式 RBAC 生效，
  **不批量提权**。
- **超级管理员**：权限集由代码计算（无 `role_permissions` 行），受保护角色不可停用 / 改权限 / 删除；
  系统保证至少存在一个生效超管（否则拒绝降权）。
- **防提权**：角色分配校验不得超出操作人自身权限范围；权限保存同样校验。
- **审计**：所有 CMS 写操作记录操作人、对象、前后差异、时间（`audit_logs`）；
  口令类操作只记「发生重置」，绝不记录口令本身。

---

## E. 账号管理 /accounts

列表（关键词搜姓名或邮箱、按职位/角色/状态筛选、分页）、新建（姓名/登录邮箱/职位/角色/
可选初始口令——留空则由后端生成强随机口令，**仅在创建响应返回一次**）、编辑、
两步确认停用/启用、重置口令（新口令一次性展示）。受保护超管账号不可停用。

---

## F. 角色与权限 /roles

角色列表（权限数 x/N、关联账号数、受保护标记）、新建/编辑弹窗、删除两步确认
（受保护或仍有关联账号的角色后端拒绝）。`/roles/[id]` 权限矩阵：**功能权限**与
**导航权限**两大分组、按模块二级分组、模块级全选；保存为覆盖式（PUT）。
新角色**默认不带任何权限**（禁止默认全给）。

---

## G. 员工联系方式 /contacts

只绑定系统中真实存在且启用的员工账号（防幽灵员工；编辑时员工固定不可改）。
展示名 / 展示邮箱 / WhatsApp 均与登录邮箱相互独立；WhatsApp 做国际格式归一化
（必须 `+` 开头、8–15 位数字，不做国家代码猜测——实测 `+86 138-0013-8000` → `+8613800138000`）。
内部备注仅后台可见（列表与公开接口均不返回）。账号停用的员工自动退出公开展示与
新询盘分配，历史记录保留；重新启用不会自动恢复公开展示。未绑定员工有补全入口。

---

## H. 询盘分配引擎 /lead-distribution

- **指针**：`lead_round_robin_state` 单行（id `round-robin`），
  `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE` 串行化；先锁状态行、
  再写询盘/分配/计划，锁顺序固定无死锁。
- **正常轮询**：按队列（启用且 `isLeadContact` 的员工）顺序；指针取
  `lastAssigneeId` 的下一格，退化到头指针 +1。
- **倾斜计划**：组内员工按各自 `targetCount` 轮流；倾斜指针由计划自身的
  `LeadAssignment` 行推导（最新一条的下一人），**不触碰正常指针**——
  计划开始/结束都不影响正常轮询进度。
- **状态机**：ACTIVE →（达标自动 COMPLETED / 手动 CLOSED / 过期 COMPLETED）；
  CLOSED + `resumeAt ≤ now` 惰性自动恢复；手动恢复即时生效。所有迁移在读取时惰性完成。
- **停用员工**：立即退出队列与计划分配（`isEligible=false`），计划不因此自动完成，
  恢复后自动回到轮转。
- **幂等**：询盘已有承接人时直接返回既有结果，不重复分配。
- **回滚安全**：分配与询盘更新在同一事务；注入失败实测无部分状态残留。

---

## I. RFQ 创建集成（#52）

公开提交 `POST /api/v1/rfq` 在同一事务内创建询盘并调用分配引擎；
分配失败仅记日志，询盘本身保持未分配（不丢线索）。后台列表/详情新增
`assigneeName / assigneeEmail / assignedAt`，支持按承接人与是否已分配筛选；
`X-Admin-Token` 通道行为不变。

---

## J. 公开 API

- `GET /api/v1/public/contacts` — 仅返回 PUBLISHED 语义下的可见联系方式
  （`showOnSite` 且账号启用），DTO 白名单，**不含** `internalNote / loginEmail / status`。
- Factory / Quality / Applications 公开接口（4.5）回归通过。

---

## K. Admin 中文界面（9 条新路由）

`/lead-distribution`、`/lead-distribution/history`、`/lead-distribution/[id]`、
`/accounts`、`/accounts/new`、`/accounts/[id]/edit`、`/roles`、`/roles/[id]`、`/contacts`。
侧边栏入口按导航权限动态显示。**按钮按状态切换**：无生效计划 →「创建倾斜计划」；
有生效计划 →「查看倾斜计划」打开弹窗（绝不直接新建）。弹窗内进度全部来自后端
`Plan` 实时数据：计划名 / 生效时间 / 状态 / 每人员目标·已分配·剩余·完成度 /
账号状态 / 最近分配 / 手动关闭（两步确认）。**关闭弹窗 ≠ 关闭计划**（E2E 专项断言）。

---

## L. 安全检查

- 管理员接口全部 JWT + 实时权限双 Guard；公开接口只读白名单。
- 口令：bcrypt cost-12；初始/重置口令仅一次性返回，不落日志。
- 防提权：角色与权限分配均不得超出操作人自身范围。
- WhatsApp / 邮箱 / 长度全部服务端校验（前端提示与服务端规则同源）。
- 内部备注、storageKey、createdBy 等内部字段不进公开 DTO。
- 空认证态、伪造 payload 均被后端拒绝（前端展示层不参与决策）。

---

## M. 测试结果（均为本次实际运行）

**后端 Jest —— 252/252，14/14 套件全通过**（`npx jest --maxWorkers=1`，61.5s）

| 套件 | 亮点 |
| --- | --- |
| `lead-distribution.e2e-spec.ts`（14） | 初始队列顺序；轮询 A,B,C,A + `roundRobinIndex` + DB 指针行；6 并发每人恰好 2 条；重复触发幂等；**事务回滚**（提交前注入失败，无残留）；倾斜轮转 A,B,A,B + 自动完成 + 指针保留；手动关闭 + 日志 + 二次关闭 400；冷却 1s 自动恢复；停用员工出队且计划不误完成；空队列不分配；公开提交自动分配 + `x-admin-token` 列表字段；401/403/200 权限矩阵；单活跃计划 + 重复员工 + 幽灵员工 400；eligible 预检 |
| 其余 13 套件 | auth / rfq / health / products / media / blog / enterprise-cms 等 4.1–4.5 回归 |

**浏览器 E2E —— 62/62 PASS**（`docs/phase-4.6-admin-e2e.mjs`，Playwright 直连单会话，
本机 Chrome，生产构建）。覆盖 §K 全部交互；控制台 0 JS 异常。
截图 14 张：`docs/phase-4.6-*.png`。

**生产服务联调（真实后端 :4000 / admin :3001 / ui :3000）**

| 场景 | 实测结果 |
| --- | --- |
| 登录 / 四模块接口 | 200，数据真实 |
| 4 条公开询盘 | 王敏→管理员→王敏→管理员（`roundRobinIndex` 0,1,0,1） |
| 倾斜计划（目标 2） | 模式切 PRIORITY_PLAN；随后 2 条全部分配给王敏；达成即自动 COMPLETED |
| 计划结束后 | 模式回 ROUND_ROBIN，指针未被打乱（第 7 条仍按原队列轮到王敏） |
| **重启后端** | 下一位承接人、每人累计、总数完全不变（指针持久化实证） |
| 创建账号 / 联系方式 | 初始口令一次性返回；WhatsApp 归一化 +8613800138000 |

**联调数据清理**：联调产生的询盘 / 分配 / 计划 / 指针 / 联系方式已清除，
测试角色与账号已清理或停用；清理后复跑 252/252 全绿。

---

## N. Build / lint / typecheck

| 侧 | 命令 | 结果 |
| --- | --- | --- |
| backend | `npx tsc --noEmit` | ✅ exit 0 |
| backend | `npm run build`（nest build） | ✅ exit 0 |
| backend | `npx jest` | ✅ 252/252 |
| admin | `npx tsc --noEmit` | ✅ exit 0 |
| admin | `npm run build`（next build） | ✅ exit 0，新增 9 条路由 |
| prisma | `migrate status` / `migrate diff` | ✅ up to date / 零漂移 |

---

## O. Git Commit 与远程推送状态

- 分支：`261016`（backend + admin 双侧一致，均自 `origin/261014` 切出——
  `origin/dev` 仍停留在 4.4 基线，故沿日常分支线推进，建议后续把 261014 合并回 dev）
- 本地身份 `bailingwood.sg <bailingwood.sg@gmail.com>`；`.env` 与任何密钥未纳入提交

| 仓库 | Commit | 变更 | 远程 261016 | 结果 |
| --- | --- | --- | --- | --- |
| bailing-backend | `4ba9513` | 57 files, +6349 / −41 | `4ba9513` | ✅ `ls-remote` 复核一致 |
| bailing-admin | `121a7ad` | 32 files, +5000 / −35 | `121a7ad` | ✅ `ls-remote` 复核一致 |

推送策略（本环境代理抖动）：GCM 取凭据 → URL 内嵌 → 禁用 credential.helper →
失败重试；两端首次即成功，远程哈希均以 `ls-remote` 复核，**非仅凭 push 回显**。
未改动 `master` / `dev` / `261014`。

---

## P. 已知问题及未完成事项

1. **`origin/dev` 落后**：停在 Phase 4.4（`e314a49` / `f485627`）。建议将 261014 合并回 dev，
   避免后续日常分支再次从落后基线切出。
2. **bailing-ui 设计系统改造未提交**（非本阶段范围）：globals.css / layout / page /
   site-header / site-footer / badge / button，留在工作区未动。
3. **根目录 `docs/` 不在任何 git 仓库内**：E2E 脚本与截图仅存本地（与 4.5 相同）。
   如需版本化，可移入 `bailing-backend/docs/`。
4. **权限注册表中 `.read` 权限标记为导航权限**：功能权限矩阵只含写操作，
   读取能力与导航入口绑定（当前设计如此，文档说明见 C）。
5. **4 个停用的 E2E 测试账号留存**（系统无账号删除接口，停用即隔离）。
6. **公开站尚未消费 `/public/contacts`**：前端展示页属下一阶段（与 4.5 报告建议一致）。

---

## Q. 下一阶段建议

1. 把 261014 / 261016 合并回 `dev`，保持干分支基线新鲜。
2. bailing-ui 接入 `/public/contacts` 与 4.5 的 Factory / Quality / Applications 详情页。
3. 询盘分配增强：按员工负载（在持询盘数）加权、假日/时区排除、分配异常告警。
4. 审计日志查询界面（当前只写不读）。
5. 提交 bailing-ui 设计系统改造（独立提交，勿与本阶段混提）。
