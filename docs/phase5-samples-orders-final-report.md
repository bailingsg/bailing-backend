# Phase 5.1 / 5.2 样品 & 订单管理系统 —— 交付报告

- 日期：2026-10-17
- 分支：`261017`（bailing-backend / bailing-admin）
- 范围：Phase 5.1 样品管理系统 + Phase 5.2 订单管理系统（含订单图片与媒体库隔离）

---

## 1. 开发前检查报告

| 仓库 | 分支 | 工作区 | 结论 |
| --- | --- | --- | --- |
| bailing-backend | 261017 | 干净 | NestJS 11 + Prisma 6 + PostgreSQL，RBAC 单事实来源为 `permission.registry.ts` |
| bailing-admin | 261017 | 干净 | Next.js 15.5.27 App Router，`lib/*.ts` 数据层 + server actions + Modal 组件体系 |
| bailing-ui | 261017 | 干净 | 公开站点，本次不涉及 |

检查要点：未覆盖任何未提交修改；未重置分支；未触生产服务器 / DNS / 邮箱；数据库变更全部走 Prisma migration。

## 2. 文件清单

### bailing-backend

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `prisma/schema.prisma` | 改 | Sample / SampleGrant / SampleRequest / Order / OrderAttachment 模型与枚举，AdminUser 反向关系 |
| `prisma/migrations/20261017170000_add_samples_and_orders/migration.sql` | 新 | 迁移（含两个部分唯一索引） |
| `prisma/seed-rbac.ts` | 改 | SALES 补 6 项预设权限；seedBuiltinRoles 改为**增量补齐**（修复既有角色不补新权限） |
| `src/modules/rbac/permission.registry.ts` | 改 | samples.* / orders.* 共 7 个权限（sortOrder 155/160） |
| `src/app.module.ts` | 改 | 注册 SamplesModule / OrdersModule |
| `src/modules/samples/**` | 新 | dto / entity / service / controller / module（持有人=创建人、授权可撤销、仅持有人审批、防自批、撤回、申请唯一、归档软删除） |
| `src/modules/orders/**` | 新 | dto / entity / service / controller / module + **order-file.service**（独立命名空间、鉴权流式读取、魔数校验、24h 临时附件清理） |
| `test/samples.e2e-spec.ts` | 新 | 15 用例 |
| `test/orders.e2e-spec.ts` | 新 | 12 用例 |
| `scripts/verify-orders-admin-flow.mjs` | 新 | 管理端 + 代理真实联调脚本（18 断言） |

### bailing-admin

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/lib/samples.ts` / `src/lib/orders.ts` | 新 | 服务端数据层、类型、金额/币种格式化、照片代理 URL |
| `src/app/api/order-photos/[orderId]/[attachmentId]/route.ts` | 新 | 订单照片**鉴权读取代理**（HttpOnly Cookie → JWT） |
| `src/app/api/order-photos/upload/route.ts` | 新 | 订单照片**上传代理**（规避 server action 体积上限，支持单张 10MB） |
| `src/app/(dashboard)/samples/**` | 新 | 列表 / 新建 / 详情（授权面板、日志、审批）/ 申请列表（三 scope）/ 归档页 / actions |
| `src/app/(dashboard)/orders/**` | 新 | 列表（筛选+分页）/ 新建 / 详情（照片墙）/ order-form / photo-uploader（XHR 进度、失败重试）/ actions |
| `src/components/admin-sidebar.tsx` | 改 | NAV_ITEMS 增加「Samples 样品管理」「Orders 订单管理」（按 samples.read / orders.read 动态显隐） |
| `src/lib/api.ts` | 改 | FormData 请求不再强制 `Content-Type: application/json`（保留 multipart boundary） |

## 3. Migration 说明

`20261017170000_add_samples_and_orders`：

- 枚举：`SampleStatus`（IN_STOCK / REQUEST_OUT / REJECTED / OUT）、`SampleRequestStatus`（PENDING / APPROVED / REJECTED / WITHDRAWN）、`OrderCurrency`（CNY / USD / EUR）。
- 表：`samples`、`sample_grants`、`sample_requests`、`orders`、`order_attachments`（orderId 可空 = 临时态）。
- 金额：`orders.amount Decimal(14,2)`，与币种分列。
- **关键约束**：
  - `CREATE UNIQUE INDEX sample_requests_one_pending_per_sample ON sample_requests("sampleId") WHERE status='PENDING'` —— 同一样品同一时间只允许一个有效申请（数据库层兜底，防并发重复申请）。
  - `CREATE UNIQUE INDEX sample_grants_one_active_per_pair ON sample_grants("sampleId","granteeId") WHERE "revokedAt" IS NULL` —— 同一被授权人同一样品只有一条有效授权。
- 已 `prisma migrate deploy` 应用到开发库 `bailingwooden` 与 e2e 库 `bailingwooden_e2e`（两库 14 → 15 个迁移）。

## 4. API 清单

### 后端（`/api/v1/cms/samples`，JwtAuthGuard + PermissionsGuard 双重守卫）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | /cms/samples | samples.read | 列表（业务员=自己的+获授权的；管理员=全部） |
| POST | /cms/samples | samples.create | 录入（持有人=会话用户，编号后端生成） |
| GET | /cms/samples/requests | samples.read | 申请列表（scope=pending/mine/all） |
| GET | /cms/samples/archive | samples.manage | 出库归档（仅管理员） |
| GET | /cms/samples/:id | samples.read | 详情（OUT 对非管理员 404，不泄漏存在性） |
| PATCH | /cms/samples/:id | samples.update | 编辑（**无 status 字段**，状态只能走申请/审批流） |
| POST | /cms/samples/:id/grants | samples.manage | 授权查看（可批量） |
| DELETE | /cms/samples/:id/grants/:userId | samples.manage | 撤销授权 |
| POST | /cms/samples/:id/requests | samples.read | 发起出库申请（申请人不可是持有人） |
| POST | /cms/samples/requests/:requestId/withdraw | samples.read | 撤回（仅申请人 + PENDING） |
| POST | /cms/samples/requests/:requestId/decide | samples.read | 审批（**仅持有人**，防自批，APPROVE→OUT 归档） |

### 后端（`/api/v1/cms/orders`）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | /cms/orders/uploads | orders.create | 上传照片（multipart，临时态，魔数校验） |
| GET | /cms/orders | orders.read | 列表（业务员仅自己；管理员全部，可按业务员筛选） |
| POST | /cms/orders | orders.create | 新建（业务员=会话用户，编号后端生成，P2002 重试） |
| GET | /cms/orders/:id | orders.read | 详情（非本人 404） |
| PATCH | /cms/orders/:id | orders.update | 编辑（全量字段 + 增删附件） |
| GET | /cms/orders/:id/attachments/:attId/file | orders.read | 附件文件流（**唯一图片访问通道**，鉴权后输出） |

### 管理端代理（Next.js route handlers）

- `POST /api/auth/login`（既有）—— JWT 写入 HttpOnly Cookie。
- `POST /api/order-photos/upload` —— 上传代理。
- `GET /api/order-photos/:orderId/:attachmentId` —— 读图代理（越权返回 403/404，未登录 401）。

## 5. 权限设计

| 权限 key | 说明 | SALES | SUPER_ADMIN |
| --- | --- | --- | --- |
| samples.read | 样品查看 nav | ✔ | 恒真 |
| samples.create / samples.update | 录入 / 编辑本人样品 | ✔ | 恒真 |
| samples.manage | 授权 / 撤销 / 归档 / 查看全部 | — | 恒真 |
| orders.read | 订单查看 nav | ✔ | 恒真 |
| orders.create / orders.update | 建单 / 编辑本人订单 | ✔ | 恒真 |

业务身份判定（服务层，不依赖 DTO）：持有人=创建人；审批仅持有人且 `requesterId !== actor.id`（防自批）；管理员**不可**代批；业务员只能看/改自己的订单（`salespersonId` 由会话取，篡改返回 400）。申请/审批/撤回不做独立权限 key，按业务身份判定，避免权限泛滥。

## 6. 测试报告

| 项目 | 结果 |
| --- | --- |
| `test/samples.e2e-spec.ts` | **15/15 通过**（归属、授权-撤销、重复申请 409、撤回、防自批/防代批 403、并发申请唯一、APPROVE 后消失、PATCH status 400 等） |
| `test/orders.e2e-spec.ts` | **12/12 通过**（金额/币种/校验、权限隔离、篡改 salespersonId 400、媒体库隔离、附件访问控制、越权关联 403、并发绑定 [201,409]、非法文件 400、磁盘位置、审计日志） |
| 后端全量 jest（e2e 库） | **377/377 通过，24/24 套件**（含登录/产品/媒体库/RFQ/SEO/发布工作流/缓存等既有回归） |
| 管理端真实联调 `scripts/verify-orders-admin-flow.mjs` | **18/18 通过**（临时账号登录 → 上传 → 建单 → 读图鉴权（本人 200 PNG 魔数 / 越权 404 / 无 Cookie 401 / 管理员 200）→ 页面渲染 → 媒体库隔离 0 命中 → 越权编辑 403；结束自动清理账号/订单/附件/文件） |
| `bailing-admin` typecheck + `next build` | 通过（tsc 0 错误；生产构建成功，/orders、/orders/[id]、/orders/new、/samples/* 全部产出） |

e2e 库说明：全量 jest 使用 `DATABASE_URL=...bailingwooden_e2e`（专用库，先 `migrate deploy` + seed，不污染开发库）；联调脚本清理后开发库 orders/samples 归零。

## 7. 手动验收清单（浏览器）

1. 用 SALES 账号登录 `http://127.0.0.1:3001`：侧边栏出现「Samples 样品管理」「Orders 订单管理」。
2. 样品：新增样品（无持有人/编号字段）→ 详情页「授权查看」勾选另一业务员 → 该业务员可见；撤销后详情 404。
3. 样品：被授权业务员「申请出库」→ 持有人「审批出库」→ 同意（含二次确认，文案见任务书 3.6）→ 样品从正常列表消失、「出库归档」可见；拒绝后可重新申请；申请人可撤回。
4. 订单：新增订单（金额非负、最多两位小数；下单时间必填）→ 下拉选择最多 9 张 JPG/PNG/WebP 照片，逐张显示进度，失败可重试 → 保存后详情页照片墙经鉴权代理显示。
5. 订单：编辑订单可增删照片；管理员看全部订单、可按业务员筛选；业务员看不到他人订单（直接输 URL 得 404）。
6. 隔离：媒体库页面搜索订单照片名称无结果；`/cms/media` 与媒体库详情接口均不返回订单附件。
7. 登出后访问 /orders、/api/order-photos/* 均被拒（307 登录 / 401）。

## 8. 已知问题与取舍

1. **订单无删除入口**：任务书未要求删除端点（OrderFileService 提供 remove 供编辑移除照片使用）；如需整单删除需后续加 `DELETE /cms/orders/:id`（软删或硬删+文件清理）。
2. **编辑为全量更新语义**：`PATCH /cms/orders/:id` 要求提交全部必填字段（与 Create 同一 DTO 派生），漏字段返回 400；前端编辑弹窗已预填全部字段规避。
3. **临时附件清理**：上传成功但最终未保存的订单照片靠后端 24h TTL 清理（purgeStaleTempAttachments），非即时删除。
4. **admin 构建环境**：`.next` 残留时 `next build` 会在 `.next/trace` 报 EPERM，需先清空 `.next` 再构建（环境特性，非代码问题）。
5. **历史提交信息**：后端 Phase 5 主体代码包含在 `e1cac24`（该提交信息描述的是邮件小改动），本次提交补齐剩余修复与前端部分。
6. lead-distribution e2e 的 `queueLength===3` 假设依赖库内无残留分配计划；干净 e2e 库上已 377/377 全过。

## 9. Git 提交

- backend：`docs/phase5-samples-orders-final-report.md`（本报告）+ 剩余修复（order-file storageKey 规范、samples OUT 404、samples e2e 并发用例修正）+ `test/orders.e2e-spec.ts` + `scripts/verify-orders-admin-flow.mjs`。
- admin：Phase 5.1/5.2 全部前端文件 + 侧边栏入口 + api.ts FormData 修复。
- 提交时核对 `git status` 无第三方未提交改动混入；推送后以 `git ls-remote` 复核远程分支。
