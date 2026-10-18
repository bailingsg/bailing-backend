# Phase 5.3：库存管理 + 订单号规范化 — 交付报告

- 日期：2026-10-18
- 分支：`261017`（三仓库）
- 基线：backend `c785181` / admin `aebd969`（Phase 5.1/5.2）

## 1. 最终状态及完成情况

| 项 | 状态 |
|---|---|
| 库存管理模块（后端 CRUD + 权限 + 审计） | 完成 |
| 订单号规范化（手动填写 / 全系统唯一 / 编辑不可改 / 精确查询） | 完成 |
| 库存与订单关联（外键 + 后端权限校验 + 订单号从订单读取） | 完成 |
| Prisma migration（inventory_items） | 已在开发库与 e2e 库执行 |
| 自动化测试（库存 e2e / 订单 e2e / 全量回归） | 全部真实执行通过 |
| admin 前端（库存全套页面 + 订单表单/列表/详情升级） | 完成，tsc + build 通过 |
| 真实 HTTP 联调（admin + backend 双服务） | 29/29 通过 |
| Git 提交与远程推送 | 见第 14 节 |
| 浏览器自动化（Playwright） | **未执行**：本环境无浏览器二进制（见第 10 节） |

测试数字来自本轮（2026-10-18 16:15–17:00）的实际执行记录，收尾阶段未重复执行。

## 2. 开发前检查报告

1. **三仓库状态**：backend / admin / ui 均在 `261017` 分支，工作区干净；backend HEAD `c785181`、admin HEAD `aebd969`，与基线一致。
2. **订单模型**：`Order.code String @unique`（原注释「后端生成 SO-YYYYMMDD-XXXXXX」），`OrdersService.generateCode('SO')` 在 create 中生成，前端无订单号输入。本阶段起改为业务员手填。
3. **历史订单号数据（只读检查）**：开发库与 e2e 库 `orders` 均为 **0 行**（空值 0、重复 0、`order_attachments` 0 行），不存在历史冲突；生产库位于 VPS，本阶段按边界要求未连接、未修改（见第 6、15 节）。
4. **订单 API**：`POST /cms/orders/uploads`、`GET/POST /cms/orders`、`GET/PATCH /cms/orders/:id`、`GET /cms/orders/:id/attachments/:attId/file`。
5. **订单前端**：`order-form.tsx`（新建/编辑弹窗）、`page.tsx`（keyword/country/closedState/salespersonId 筛选）、`[id]/page.tsx` 详情。
6. **权限机制**：orders.read/create/update；`isSuperAdmin` 恒全集；业务员按 `salespersonId` 隔离；JwtAuthGuard + PermissionsGuard + `@RequirePermissions`。
7. **迁移历史**：14 个迁移，最新 `20261017170000_add_samples_and_orders`；本阶段新增第 15 个。
8. **Phase 5.2 已知问题核对**（报告 `docs/phase5-samples-orders-final-report.md` 第 8 节）：
   - 「编辑为全量更新语义」→ **直接影响本阶段**：已通过 DTO 重构解决（UpdateOrderDto 不再含 code，编辑不再要求订单号，也不会误改订单号）；
   - 「暂无整单删除端点」→ 与本阶段无直接冲突，按「不擅自扩大范围」原则保留，仅记录（见第 12 节）；
   - 临时附件 24h TTL 清理、`.next` EPERM 等为环境特性，与本阶段无冲突。
9. **测试配置**：e2e 走 `Test.createTestingModule(AppModule)` + supertest；全量 jest 必须带 e2e 库 `DATABASE_URL`，且跑前对 e2e 库 `migrate deploy` + seed（e2e 库原落后一个迁移，已补齐）。

## 3. 修改的仓库和文件清单

### bailing-backend
- 修改：`prisma/schema.prisma`（InventoryItem 模型、AdminUser/Order 反向关系、Order.code 注释）
- 修改：`prisma/seed-rbac.ts`（SALES 增加 inventory.* 4 项）
- 修改：`src/app.module.ts`（注册 InventoryModule）
- 修改：`src/modules/orders/dto/orders.dto.ts`（订单号字段与查询、DTO 重构）
- 修改：`src/modules/orders/orders.service.ts`（手动订单号 + 409 + 精确查询）
- 修改：`src/modules/rbac/permission.registry.ts`（inventory 模块 4 权限）
- 修改：`test/orders.e2e-spec.ts`（适配手动订单号 + 3 个新用例）
- 新增：`prisma/migrations/20261018093000_add_inventory_items/migration.sql`
- 新增：`src/modules/inventory/`（dto / entities / service / controller / module 共 5 文件）
- 新增：`test/inventory.e2e-spec.ts`
- 新增：`scripts/verify-inventory-order-flow.mjs`
- 新增：`docs/phase-5.3-inventory-order-number-final-report.md`（本报告）

### bailing-admin
- 修改：`src/lib/orders.ts`（OrderInput.code、OrderListQuery.code、OrderUpdateInput 去掉 code）
- 修改：`src/app/(dashboard)/orders/order-form.tsx`（新建订单号必填 + 编辑只读）
- 修改：`src/app/(dashboard)/orders/page.tsx`（订单编号筛选 + 分页保留条件）
- 修改：`src/app/(dashboard)/orders/[id]/page.tsx`（新增库存入口 + 关联库存卡）
- 修改：`src/components/admin-sidebar.tsx`（库存管理入口，inventory.read）
- 新增：`src/lib/inventory.ts`
- 新增：`src/app/(dashboard)/inventory/`（actions / page / inventory-form / delete-button / [id]/page / new/page）

## 4. 新增及修改的数据模型

### 4.1 新增 `InventoryItem`（表 `inventory_items`）

| 字段 | 类型 | 规则 |
|---|---|---|
| id | String @id @default(cuid()) | 系统主键 |
| code | String @unique | 库存编号，后端生成 `INV-YYYYMMDD-XXXXXX`，全局唯一 |
| productName | String | 产品名称（必填，≤160） |
| productDetail | String @db.Text | 产品详情：规格/材质/型号（必填，≤5000） |
| quantity | Decimal @db.Decimal(14,3) | 数量：非负、最多三位小数；**不用浮点**，杜绝二进制精度误差 |
| unit | String | 计量单位白名单：张/片/块/套/件/根/立方米/平方米/米/千克/吨 |
| location | String | 存放位置（单仓库，手动输入，≤200） |
| storedAt | DateTime | 存放日期（必填） |
| orderId | String? | 关联订单（可空）；FK ON DELETE RESTRICT |
| createdById | String | 创建人（后端从会话确定）；FK ON DELETE RESTRICT |
| createdAt / updatedAt | DateTime | 系统生成 / 自动更新 |

索引：`code`（唯一）、`createdById`、`orderId`、`productName`、`storedAt`、`createdAt`。

### 4.2 数量规则落地

- DTO：`@IsNumber({ maxDecimalPlaces: 3 }) @Min(0)`；服务层二次用 `Prisma.Decimal` 判负与小数位，落库 `toFixed(3)`。
- 序列化：`formatQuantity()` 去掉尾零与小数点（`12.125` / `5` / `0.125` 均精确）。
- 本阶段只记录数量，**不实现任何自动扣减**（按任务边界）。

### 4.3 修改的订单模型

- `Order.code` 注释改为「业务员手动填写，全系统唯一（trim 首尾；精确匹配、区分大小写）」；`Order` 增加反向关系 `inventoryItems`，`AdminUser` 增加 `inventoryItems`（`InventoryCreator`）。
- 订单结构本身无列变更（唯一索引 `orders_code_key` 已由上一迁移建立）。

## 5. Prisma migration 文件和执行结果

- 文件：`bailing-backend/prisma/migrations/20261018093000_add_inventory_items/migration.sql`
- 内容：创建 `inventory_items` 表 + 唯一索引 `inventory_items_code_key` + 5 个二级索引 + 两个 RESTRICT 外键（orderId→orders、createdById→admin_users）。
- 执行结果（真实执行）：
  - 开发库 `bailingwooden`：`npx prisma migrate deploy` 成功应用；
  - e2e 库 `bailingwooden_e2e`：同迁移应用成功（该库原本落后一个迁移，已一并补齐并重新 seed，permissions=80）；
  - `npx prisma migrate diff --from-schema-datasource --to-schema-datamodel --script` 输出 `-- This is an empty migration.`（schema 与库结构一致，无漂移）。
- 未重建任何数据库；未执行 `db push` / `migrate reset`。

## 6. 订单号规范化与历史数据兼容说明

### 6.1 规范化规则（前后端一致）

- **trim 首尾**：DTO 层 `@Transform` 先 trim 再校验（`  BW-2026-0001  ` → `BW-2026-0001`）；服务层 `dto.code.trim()` 兜底。
- **字符白名单**：`/^[\p{L}\p{N}\-_.\/#]+(?: [\p{L}\p{N}\-_.\/#]+)*$/u`——允许字母、数字、`- _ / . #` 与**单个空格**分隔；天然拒绝空串、纯空格、控制字符、首尾空格；不限制纯数字。
- **长度**：1–64。
- **大小写**：**不折叠、区分大小写**（与 PostgreSQL 唯一索引 `orders_code_key` 的精确匹配行为一致），避免把历史不同订单号误并；未做全角/半角转换。
- 前端 `ORDER_CODE_RULE` 与后端 `ORDER_CODE_PATTERN` 为同一条正则。

### 6.2 唯一性三层保护

1. 前端表单校验（必填 + 正则 + 长度，提交前拦截）；
2. 后端服务层：`P2002` → `ConflictException('该订单号已存在，请检查后重新输入')`（不暴露堆栈/SQL）；
3. 数据库唯一索引 `orders_code_key`（并发创建相同订单号时只有一个成功）。

### 6.3 编辑规则

- **订单号创建后不可修改**：`UpdateOrderDto` 由「继承 CreateOrderDto」重构为「与 Create 共用 `OrderFieldsDto`，但不含 code」；编辑表单只读展示原值；PATCH 携带 code → 400（白名单拒绝）。这样同时消除了 Phase 5.2 全量更新语义下「漏字段 400」与「误改订单号」两类风险。
- 数据库 ID 仍为主键；订单号仅为业务编号。

### 6.4 历史数据兼容（只读检查结果）

- 本地开发库与 e2e 库：`orders` 均为 0 行 → 空值 0、重复 0、格式不一 0；`order_attachments` 0 行；**无库存或其他数据引用历史订单号**（`inventory_items` 为本阶段新建）。
- 生产库（VPS 43.159.152.116）本阶段未连接、未修改。**部署前必须执行的只读核查**（见第 15 节）：若发现空值/重复，需单独批准的数据修复方案（本阶段不自动改生产数据、不删历史订单）。
- 库存侧 `orderId` 外键为 RESTRICT：删除/归档订单不会级联删除库存；订单号始终从关联订单实时读取，不冗余副本。

## 7. API 接口清单

### 库存管理（新，`cms/inventory`，全局 JwtAuthGuard + PermissionsGuard）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/v1/cms/inventory | inventory.read | 列表：服务端分页 + 筛选（code 精确 / keyword / location / orderCode / storedFrom–storedTo）；业务员仅自己的 |
| POST | /api/v1/cms/inventory | inventory.create | 新增（创建人=当前用户；orderId 可空，提供时校验存在+权限） |
| GET | /api/v1/cms/inventory/:id | inventory.read | 详情（越权 404，不泄漏存在性） |
| PATCH | /api/v1/cms/inventory/:id | inventory.update | 编辑（字段白名单；code/createdById 提交即 400） |
| DELETE | /api/v1/cms/inventory/:id | inventory.delete | 删除（硬删 + 审计日志；不触及订单） |
| GET | /api/v1/cms/inventory/orders/:orderId | inventory.read | 某订单关联的库存（订单详情页） |

### 订单（变更，`cms/orders`）

| 方法 | 路径 | 变更 |
|---|---|---|
| POST | /cms/orders | `code` 改为**必填**（业务员手填）；不再自动生成；P2002→409「该订单号已存在，请检查后重新输入」 |
| PATCH | /cms/orders/:id | DTO 不再接受 `code`（创建后不可改）；其余字段保持全量更新语义 |
| GET | /cms/orders | 新增 `code` 精确查询参数（与 keyword/country/closedState/salespersonId 叠加，仍受角色过滤） |

其余端点（uploads、附件文件流）不变。

## 8. 权限与安全设计说明

- **权限模型**：新增 `inventory` 模块（sortOrder 165）4 项权限；SALES 角色种子补齐 read/create/update/delete；侧边栏按 `inventory.read` 显隐。
- **数据隔离**：
  - 库存：业务员仅可见/可改/可删 `createdById = 本人`；管理员全部；越权详情 404（不泄漏存在性）、越权编辑/删除 403。
  - 订单：维持 `salespersonId` 隔离；按订单号搜索同样受权限过滤（业务员搜他人订单号 → 0 条）。
- **重点防护对照**：
  - IDOR / 越权读写删：服务层逐一校验（本报告第 9 节用例覆盖）；
  - 伪造创建人：`createdById` 恒取会话，DTO 白名单拒绝（400 实测）；
  - 伪造订单关联：服务层校验订单存在 + (本人或管理员)，否则 403/400（实测 403）；
  - 重复/并发订单号：服务层 409 + DB 唯一索引（e2e 并发用例 [201,409] 实测）；
  - 关联不一致：订单号只从关联订单实时读取，无冗余副本；
  - 非法金额/数量：金额 Decimal(14,2)、数量 Decimal(14,3) 非负 + 小数位校验（实测负数量 400）。
- **删除策略**：库存硬删 + AuditLog 保留 summary；`orderId` FK RESTRICT，删除库存不会级联删除订单或订单附件（实测删库存后订单仍可读）。

## 9. 自动化测试的实际执行结果

均为本轮真实执行（2026-10-18），非收尾阶段重跑：

| 测试 | 结果 | 覆盖要点 |
|---|---|---|
| `test/inventory.e2e-spec.ts` | **15/15 通过** | CRUD、编号生成、Decimal 精度(12.125/5)、负数量与超精度 400、单位白名单、字段白名单(code/createdById→400)、越权 404/403/403、从订单创建自动关联+orderCode 正确、伪造关联 403/400、删除不影响订单、筛选(编号/关键词/位置/日期范围/订单号)、分页、审计日志 |
| `test/orders.e2e-spec.ts` | **15/15 通过** | 手动订单号原样保存、必填/空/纯空格/控制字符/超长 400、trim 保存、重复 409、并发同号 [201,409]、精确查询与筛选叠加、编辑不带 code 且不可篡改、原 Phase 5.2 用例（三币种/权限/附件隔离/越权关联/并发绑定[201,409]/非法文件/磁盘位置/审计） |
| 全量回归 `npx jest`（e2e 库） | **393/393 通过，25/25 套件全绿** | 含 samples 15、orders 15、inventory 15、media/rfq/seo/publishing/lead-distribution/revalidation 等全部既有套件（登录、样品授权审批、订单图片、媒体隔离均未破坏） |
| admin `npx tsc --noEmit` | **0 错误** | 全部新增/修改页面 |
| admin `next build`（先清 `.next`） | **通过** | `/inventory`、`/inventory/[id]`、`/inventory/new`、`/orders`、`/orders/[id]` 等路由全部产出 |

## 10. 浏览器联调结果

**限制（如实说明）**：本环境未安装 Playwright 浏览器二进制（`~/AppData/Local/ms-playwright` 无浏览器、`playwright` 包不可解析），**浏览器自动化未执行，不得视为通过**。

采用的替代验证（均为真实执行，非伪造）：

- `scripts/verify-inventory-order-flow.mjs`：在真实运行的服务（admin `127.0.0.1:3001` 生产构建 + backend `127.0.0.1:4000` 生产构建）上，经真实登录（HttpOnly Cookie + JWT）跑通 **29/29 断言**，覆盖任务书 11.5 的等价路径：
  1. 管理员/业务员登录（3 账号）；
  2. 新建订单并填写订单号（原样保存）；
  3. 重复订单号创建 → 409「该订单号已存在」；
  4. 按订单号精确查询（管理员命中、叠加筛选 0 条、业务员搜他人订单号 0 条）；
  5. 从订单详情进入新增库存（`/inventory/new?orderId=` 页面渲染且显示订单号）；
  6. 保存库存并验证关联（orderId/orderCode 正确带入）；
  7. 库存列表按订单号查询、列表渲染、编辑、删除；
  8. 普通业务员数据隔离（越权列表 0 条、详情 404、编辑/删除 403）；
  9. 页面 HTML 断言（订单列表含「订单编号」筛选、库存列表含「库存管理/新增库存/关联订单号」、订单详情含「关联库存」卡与「新增库存」按钮）；
  10. 未登录访问 /orders、/inventory → 307 跳登录；未登录访问后端 /cms/inventory → 401。
  脚本 `finally` 自清理，验证后开发库 `verify-inv` 账号 0 残留、inventory 0 行、orders 0 行。
- 响应式布局：复用后台既有「桌面表格（lg:block）+ 移动卡片（lg:hidden）」双渲染模式，经 `next build` 产出验证；未在真实设备/视口下截图。
- 回归覆盖（11.4）：全量 jest 25/25 套件包含登录、样品、样品授权审批、订单 CRUD、订单图片上传读取、媒体库隔离、RFQ、产品、SEO、导航权限相关用例。

## 11. 手动验收步骤

1. 以管理员登录 `http://127.0.0.1:3001`（生产构建）→ 左侧出现「订单管理 / 库存管理」。
2. 订单管理 → 新增订单：填写订单号（如 `BW-2026-0001`）→ 保存成功，详情页显示该编号；再次使用同一订单号 → 提示「该订单号已存在」。
3. 订单列表「订单编号」输入框精确查询；与「国家/地区」「成交状态」叠加；点「重置」清空。
4. 订单详情 → 「新增库存」→ 表单顶部锁定显示当前订单号 → 保存 → 详情页「关联库存」卡出现该记录；点击库存编号进入库存详情。
5. 库存管理 → 新增库存（不关联订单）→ 列表/详情/编辑/删除（删除有二次确认）。
6. 库存列表分别用「库存编号 / 关键词 / 存放位置 / 存放日期范围 / 关联订单号」筛选，验证分页。
7. 用业务员账号登录：只能看到自己的订单与库存；直接改 URL 访问他人记录 → 404。
8. 缩小窗口至手机宽度：表格切换为卡片布局。

## 12. 已知问题及后续建议

1. **Playwright 未执行**：本环境缺浏览器二进制；如需真实浏览器回归，需先安装 Playwright 浏览器（`npx playwright install chromium`）后补跑。
2. **订单无整单删除端点**（Phase 5.2 遗留，本阶段未扩大范围）：如需删除订单，建议后续以软删 + 附件文件清理实现，避免级联风险。
3. **编辑仍为全量更新语义**：PATCH 需提交全部业务字段（订单号除外）；前端编辑弹窗已预填规避。
4. **库存编号不可编辑**（设计决策）：系统生成 `INV-YYYYMMDD-XXXXXX`，未提供手工修改入口。
5. **大小写敏感**：订单号区分大小写（与 DB 唯一索引一致）；如业务要求忽略大小写，需先普查历史数据再评估迁移（本阶段不做）。
6. **单位白名单固定 11 项**：新增单位需同步后端 `INVENTORY_UNITS` 与前端下拉（无运行时配置入口）。
7. **生产迁移**：`20261018093000_add_inventory_items` 尚未在生产库执行；生产部署前须完成第 15 节核查与审批。

## 13. Git diff 概要

提交前 `git status` / `git diff --stat`（工作区仅含本阶段变更，无第三方未提交修改混入）：

**bailing-backend**
```
 M prisma/schema.prisma                      （InventoryItem 模型 + 关系 + code 注释）
 M prisma/seed-rbac.ts                       （SALES +inventory.* 4 项）
 M src/app.module.ts                         （注册 InventoryModule）
 M src/modules/orders/dto/orders.dto.ts      （订单号必填/查询、DTO 重构）
 M src/modules/orders/orders.service.ts      （手动订单号 + 409 + 精确查询）
 M src/modules/rbac/permission.registry.ts   （inventory 模块 4 权限）
 M test/orders.e2e-spec.ts                   （适配 + 3 新用例）
?? prisma/migrations/20261018093000_add_inventory_items/
?? src/modules/inventory/                    （5 文件）
?? test/inventory.e2e-spec.ts
?? scripts/verify-inventory-order-flow.mjs
?? docs/phase-5.3-inventory-order-number-final-report.md
```

**bailing-admin**
```
 M src/lib/orders.ts                         （code 输入/查询类型）
 M src/app/(dashboard)/orders/order-form.tsx （订单号必填 + 编辑只读）
 M src/app/(dashboard)/orders/page.tsx       （订单编号筛选 + 分页条件保留）
 M src/app/(dashboard)/orders/[id]/page.tsx  （新增库存入口 + 关联库存卡）
 M src/components/admin-sidebar.tsx          （库存管理入口）
?? src/lib/inventory.ts
?? src/app/(dashboard)/inventory/            （6 文件）
```

未提交 `.env`、密钥、日志、临时数据或构建产物（`.next`、`dist`、`node_modules` 均未被跟踪）。

## 14. Git 提交哈希和远程推送核验结果

> 执行方式与实际结果如下。

执行方式：
- backend：一次提交包含库存模块、迁移、订单号规范化、测试、联调脚本与本报告；
- admin：一次提交包含全部 Phase 5.3 前端；
- 分支 `261017`；推送前先 `ls-remote` 检查远程状态，若远程领先则先分析整合（禁止强推）；推送后以 `git ls-remote` 复核远程哈希与本地一致。

**实际结果**：backend `66ef13c`（16 文件，+1980/-41，功能主体）+ `4ad0ffd`（本报告回填）；admin `78af49a`（12 文件，+1262/-20）。两仓库均已于 2026-10-18 推送至 `bailingsg/bailing-backend` 与 `bailingsg/bailing-admin` 的 `261017` 分支（backend `c785181..66ef13c`、admin `aebd969..78af49a`，快进无冲突，未强推）；推送后 `git ls-remote` 复核：远程哈希与本地 `rev-parse 261017` 完全一致（backend `66ef13c16c2303e17b0fc0f6ec7b5df2dd9cb888`、admin `78af49ac6f476397bc71a7c5e941634a594d671f`）。

## 15. 生产部署前仍需执行的步骤

1. **只读核查生产库订单号**（在 VPS 上以只读方式执行，需单独批准）：
   ```sql
   SELECT count(*) AS total FROM orders;
   SELECT count(*) AS empty_code FROM orders WHERE code IS NULL OR btrim(code) = '';
   SELECT btrim(code) AS t, count(*) FROM orders GROUP BY 1 HAVING count(*) > 1;
   SELECT count(*) AS bad_format FROM orders WHERE code !~ '^[\p{L}\p{N}\-_.\/#]+(?: [\p{L}\p{N}\-_.\/#]+)*$' OR length(btrim(code)) > 64;
   ```
   - 若存在空值/重复：**停止迁移**，制定确定性修复方案并获批准后再执行（不得删历史订单、不得猜测覆盖业务订单号）。
   - 若全部通过：在生产库执行 `npx prisma migrate deploy`（应用 `20261018093000_add_inventory_items`）。
2. 重新构建并部署 backend / admin 镜像（沿用现有 Docker 多阶段构建）；backend 需重新 seed 以使 `inventory.*` 权限进入既有角色（种子为增量补齐，不影响手工授权）。
3. 部署后在生产环境用管理员账号按第 11 节抽查：订单号必填与唯一、订单号查询、从订单新增库存、库存 CRUD 与删除确认、业务员隔离。
4. Playwright 浏览器回归（可选）：安装浏览器二进制后补跑第 11 节流程。
5. 安全组/域名/TLS 等 Phase 1 遗留事项不在本阶段范围。

---

**结论**：Phase 5.3 功能开发、迁移、自动化测试、真实 HTTP 联调均已完成并通过；唯一未执行项为 Playwright 浏览器自动化（环境缺浏览器二进制，已在第 10 节如实记录）。在上述核查与部署步骤完成前，不标记生产上线完成。
