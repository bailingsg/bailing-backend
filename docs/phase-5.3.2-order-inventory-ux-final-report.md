# Phase 5.3.2 订单-库存联动 UX 改造 · 最终报告

> 执行日期：2026-10-19
> 分支：`261017`（bailing-backend / bailing-admin）
> 状态：**COMPLETE**
> 验收结论：三条需求全部落地并通过真实浏览器 + 真实 HTTP + 全量后端测试验证

---

## 一、任务概述与范围

本阶段只做三件用户体验改造，不新增业务概念、不改数据库结构：

| 编号 | 需求 | 交付状态 |
| --- | --- | --- |
| R1 | 订单表单增加「是否有库存？」（是/否，默认否），选「是」展开库存子表单，新建/编辑与订单联动 | 已完成 |
| R2 | 新增库存保存后回到库存列表（带成功提示、保留筛选）；从订单详情进入则回订单详情 | 已完成 |
| R3 | 库存列表操作列「详情」改为「删除」，保留「编辑」；删除二次确认、留在列表、不级联订单 | 已完成 |

**改动仓库**：`bailing-backend`（提交 `fca3c55`）、`bailing-admin`（提交 `2a983d4`）。
`bailing-ui` 未改动；`bailing-admin` 中用户既有的 2 处 RFQ 改动（`src/app/(dashboard)/rfq/page.tsx`、`src/lib/rfq.ts`）**原样保留、未提交**。

**明确未做**：生产部署、生产数据库迁移、DNS/邮件/防火墙/SSH 任何变更、强制推送。

---

## 二、需求逐条对照

### R1 订单表单「是否有库存？」

- 位置：订单新建/编辑弹窗内、`备注` 之后，独立 `fieldset`，默认选中「否」。
- 选「是」展开 6 个库存字段：产品名称 / 产品详情 / 数量 / 计量单位 / 存放位置 / 存放日期，单位下拉复用 `INVENTORY_UNITS`，数量规则复用「非负 + 最多三位小数」。
- 新建：订单与库存由后端**同一事务**写入，库存 `orderId` 自动取新建订单 ID，`createdById` 恒为当前登录用户。
- 编辑：有库存则「是」并回填，保存时**更新原记录**（按主库存 ID），不重复新增；原本无库存则新建一条。
- 改为「否」：先弹出确认块（保留库存 / 确认删除库存）。**未确认时保存会被前端拦下并提示**；确认后也只在保存时才提交 `removeInventory: true`。
- 防重复提交：`useRef` 同步锁 + `pending` 禁用按钮，连点 3 次只产生 1 条库存（浏览器用例 H13 已验证）。

### R2 新增库存返回列表

- 从库存列表进入：保存后**停留在 `/inventory`**，`router.refresh()` 刷新数据，右下角提示「库存已新增，列表已刷新」，**不再跳详情页**。
- 筛选条件与页码：停留在同一 URL，`router.refresh()` 携带原 `searchParams`，筛选不丢失（用例 I2 验证 URL 仍带 `keyword`）。
- 从订单详情进入（`/inventory/new?orderId=`）：保存后跳回 `/orders/{id}?notice=inventory-created`，订单详情页顶部显示成功提示条。

### R3 库存列表操作列

- 桌面表格操作列：`编辑`（行内弹窗，回填可改）+ `删除`（二次确认），**已移除「详情」**。
- 删除确认弹窗展示：库存编号、产品名称、数量（含单位）、存放位置，并明确「仅删除这条库存记录；该订单及其它数据不会被删除」。
- 删除成功：停留列表、刷新、提示「库存 XXX 已删除」，**不跳转**。
- 不级联：后端库存删除只作用于 `inventory_items` 行（订单侧无级联规则，库存侧 FK 为 `ON DELETE RESTRICT`），订单与订单照片不受影响（用例 J6 通过 UI 删除后校验订单 200 且字段完好）。
- 移动端卡片同步改造：不再整卡跳详情，卡片内提供编辑/删除。

---

## 三、后端实现

### 3.1 事务设计

`OrdersService.create` 与 `OrdersService.update` 均把订单行与库存行放进**同一个 `prisma.$transaction`**：

```
create:  [ order.create ] + [ inventoryItem.create (可选) ]  → 一个事务
update:  [ order.update ] + [ inventory 更新/新建/删除 (可选) ] → 一个事务
```

因此不存在「订单建好了库存没建」或反向的中间态。库存字段非法时整个事务回滚，订单不落库（e2e 用例与 HTTP 用例 7/8 双重验证）。

**编号碰撞处理**：库存编号 `INV-YYYYMMDD-XXXXXX` 由 `randomBytes(4)` 生成。事务内出现 `P2002` 时不能靠"重试单条 insert"（Postgres 已把事务置为 aborted），因此改为**换新编号重跑整个事务**（上限 5 次）。`create` 中额外先查订单号是否已被占用，以区分「订单号重复（409 明确提示）」与「库存编号碰撞（换码重试）」。

### 3.2 接口契约

```
POST  /cms/orders
  { code, customerName, country, requirement, orderedAt, closedAt?, amount,
    currency, note?, attachmentIds?, inventory?: { productName, productDetail,
    quantity, unit, location, storedAt } }

PATCH /cms/orders/:id
  { ...同上（无 code）, removeAttachmentIds?, inventory?, removeInventory? }
```

- `inventory` 与 `removeInventory` **语义互斥**，同时提交返回 400。
- 不传 `inventory` 且不传 `removeInventory` → **完全不触碰库存**（静默删除防护的服务端兜底）。
- 订单响应体**不夹带**库存字段，库存仍由 `/cms/inventory/orders/:orderId` 独立输出，保持既有契约不变。

### 3.3 主库存定义

「主库存」= 该订单 `createdAt` 最早的一条（同刻按 `id` 升序）。订单表单只回填/更新这一条；订单可能还有从库存列表额外新增的多条记录，它们不受订单表单影响。前端 `pickPrimaryInventory()` 与后端 `findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })` 规则逐字一致。

当订单存在多条库存时，表单会显示「该订单共有 N 条库存记录，此处仅显示并编辑最早创建的一条」。

### 3.4 规则复用

新增 `src/modules/inventory/inventory.support.ts`：

- `generateInventoryCode(now?)` — 编号生成
- `toInventoryQuantity(value)` — 非负 + 最多三位小数 → `Prisma.Decimal`

`InventoryService` 与 `OrdersService` 共用，避免「同一条库存从两个入口写入规则不一致」。

### 3.5 审计

订单写入后记录两条审计：`order.create` / `order.update`（diff 里带 `inventory` 标记），以及 `inventory.create|update|delete`（diff 带 `orderId` 与 `source: 'order-form'`），可追溯「这条库存是从订单表单还是库存模块产生的」。

---

## 四、前端实现

| 文件 | 变更 |
| --- | --- |
| `orders/order-form.tsx` | 新增「是否有库存？」单选 + 条件库存子表单 + 二次确认删除 + 提交锁 |
| `orders/[id]/page.tsx` | 传入主库存与库存条数；新增 `?notice=` 成功提示条 |
| `orders/new/page.tsx` | 修正过时文案（原写"订单编号由系统生成"，实际为手动填写） |
| `orders/actions.ts` | 创建/更新后同时失效 `/inventory` 缓存 |
| `inventory/inventory-form.tsx` | 新增后留在列表并提示；订单入口仍回订单详情；新增 `triggerLabel`/`compact` |
| `inventory/page.tsx` | 操作列改为编辑+删除；移动端卡片改造 |
| `inventory/inventory-row-actions.tsx` | 新增：行内 编辑 + 删除 |
| `inventory/delete-button.tsx` | 确认弹窗补充编号/产品/数量/位置；删除后提示 |
| `inventory/[id]/page.tsx` | 删除按钮传入完整信息；修正编辑弹窗默认自动打开 |
| `components/ui/toast.tsx` | 新增全局 `ToastHost` + `showToast` |
| `(dashboard)/layout.tsx` | 挂载 `ToastHost` |
| `lib/orders.ts` | 新增 `OrderInventoryInput`、`removeInventory` 类型 |
| `lib/inventory.ts` | 新增 `pickPrimaryInventory` |

### 4.1 为什么 toast 要做成全局宿主

第一轮浏览器验收时 J5 失败：「删除成功提示」不出现。原因是删除后 `router.refresh()` 会把被删的那一行（连同它内部的客户端组件）卸载，挂在组件 state 上的 toast 随之消失。改为**模块级 store + 布局常驻的 `ToastHost`** 后，行卸载不影响提示（第二轮通过）。

这是本轮真实测试抓到的设计缺陷，不是猜测。

---

## 五、数据一致性与防误删设计（三道闸）

1. **UI 层**：改为「否」先出确认块，用户必须点「确认删除库存」；未确认时保存被前端 `validate()` 拦下（提示"请先确认是否删除该订单已关联的库存记录"）。
2. **请求层**：只有确认后才带 `removeInventory: true`；不确认时该字段根本不发送（`undefined`）。
3. **服务层**：不传 `inventory` 也不传 `removeInventory` → 一行库存代码都不执行；两者同时传 → 400 拒绝。

防重复新增同理：前端 ref 锁 + 后端「有主库存则 update，无则 create」，二者叠加后即使请求被重放也不会产生第二条。

---

## 六、权限与安全

- 订单编辑：仍沿用既有判定（管理员全部、业务员仅本人），越权 403。
- 库存联动写入：**以订单编辑权限为授权依据**（不是库存 `createdById`）。理由：管理员在业务员订单上创建的库存，业务员编辑自己的订单时应当能改，否则表单会莫名报 403。库存创建人字段不被联动写入篡改（e2e 用例已验证管理员更新他人订单库存后 `createdById` 仍为原业务员）。
- 库存模块自身的 `update/delete` 仍保持「只能改/删自己创建的」原语义，未放宽。
- 客户端无法指定库存 `orderId`（嵌套 DTO 不含该字段），`whitelist + forbidNonWhitelisted` 会对多余字段返回 400，杜绝把库存挂到别人的订单上。
- 越权查看他人库存详情仍返回 404（不泄漏存在性），浏览器用例 K2 通过。

---

## 七、测试执行结果

### 7.1 后端单元 + e2e（Jest，串行，指向 `bailingwooden_e2e`）

```
Test Suites: 27 passed, 27 total
Tests:       411 passed, 411 total
Time:        70.707 s
```

本阶段新增：

- `test/order-inventory-link.e2e-spec.ts` — 12 例：同事务创建、字段非法整体回滚、重复订单号 409 无残留、不传不触碰、编辑更新不新增、编辑不传不删、无库存时新建、`removeInventory` 删除、互斥 400、越权 403、管理员跨人更新、删除库存不影响订单。
- `test/inventory-support.spec.ts` — 6 例：编号格式/随机性、数量精度、负数、超三位小数、非数字。

### 7.2 管理后台类型检查与构建

```
npx tsc --noEmit     → 0 error
npm run build        → 成功（.next 先清理，避免 EPERM）
```

### 7.3 真实浏览器验收（Playwright + 系统 Chrome，1440×900 / 390×844）

脚本：`docs/phase-5.3.2-browser/browser-acceptance.mjs`
结果：`docs/phase-5.3.2-browser/browser-results.json`

```
检查 27 项，通过 27，失败 0，阻塞 0
截图 12 张
pageerror 0
console.error 0
```

覆盖分组：

| 组 | 内容 | 结果 |
| --- | --- | --- |
| H1–H13 | 默认否、展开、校验、创建、回填、更新不新增、二次确认、保留、确认删除、选否不建、连点防重 | 13/13 |
| I1–I3 | 新增留列表、筛选保持、订单入口回订单详情 | 3/3 |
| J1–J7 | 操作列、行内编辑、删除弹窗内容、取消、确认、不级联订单、移动端 | 7/7 |
| K1–K2 | 他人库存不可见、越权 404 | 2/2 |
| L1–L2 | 无 pageerror、无 console.error | 2/2 |

截图目录：`docs/phase-5.3.2-browser/screenshots/`（12 张，含默认否、展开子表单、订单详情库存、编辑回填、二次确认、删除后订单保留、留列表、回订单详情、操作列、删除弹窗、移动端卡片）。

### 7.4 真实 HTTP 集成（直连 4000 端口，完整网络栈 + JWT）

脚本：`docs/phase-5.3.2-browser/http-integration.mjs`

```
22 通过 / 0 失败
```

含：201 创建并自动关联、编号格式、Decimal 精度、非法库存 400 + **事务回滚订单不落库**、重复订单号 409 且不新增库存、编辑更新同一条 ID、不传不删、互斥 400、`removeInventory` 删库存留订单、独立接口删除库存不级联订单。

### 7.5 测试数据清理

- 浏览器与 HTTP 脚本结束时按 `QA-PH532` 前缀清理订单、库存、附件行。
- 复核：`QA-PH532` 订单 0 条、库存 0 条。
- 说明：e2e 库中另有 1 条更早会话遗留的库存（`productName='1111'`，无关联订单，创建于本阶段测试开始前），非本阶段产生，未擅自删除。

---

## 八、本轮发现并修复的缺陷

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| F1 | 删除成功后提示丢失：行被 `router.refresh()` 卸载，组件内 toast 随之消失 | 改为模块级 store + 布局常驻 `ToastHost` |
| F2 | 库存详情页进入时编辑弹窗自动打开（`open` 初值对 edit 恒为 true） | 默认关闭，仅在显式传 `open` 或点击触发按钮时打开 |
| F3 | `/orders/new` 页面文案仍写"订单编号由系统生成" | 改为"手动填写且全系统唯一" |
| F4 | 事务内 P2002 无法靠单条 insert 重试（事务已 aborted） | 改为换新编号重跑整个事务，并在 create 中先区分订单号冲突 |

> F1 与 F2 均由真实浏览器/真实数据触发后才暴露，属"读代码看不出来"的问题。

---

## 九、已知限制与遗留问题

1. **多库存订单**：订单表单只管理「主库存」（最早一条）。若订单有 N>1 条库存，表单会明确提示，其余需在库存列表管理。当前业务下一条订单对应一条库存，属可接受折中；若后续要求"一订单多批次库存"，需要把表单改为列表编辑器。
2. **库存详情页仍存在**：列表「操作列」不再提供详情入口，但库存编号仍可点击进入详情（查看产品详情全文）。未删除该路由，避免破坏既有链接与书签。
3. **库存数量语义**：本阶段库存仍为"记录型"（数量 + 位置），不做出入库流水与扣减。订单与库存是关联关系而非消耗关系。
4. **并发极端场景**：两个请求同时把同一订单的库存从无改有，理论上可能各自 create 出一条（当前无数据库级"一订单一条主库存"的唯一约束）。已用「前端提交锁 + 后端先查后写」覆盖常规场景；如需硬保证，需新增部分唯一索引（`inventory_items(order_id)` where order_id not null），属下一阶段数据库变更，本阶段未动 schema。
5. **未做**：库存删除的软删除/回收站、批量删除、操作撤销。

---

## 十、数据库与迁移影响

- **无 schema 变更**：未新增表、未改字段、未新增索引、未新增迁移文件。
- 现有约束已足够支撑：`inventory_items.order_id` 可空外键（`ON DELETE RESTRICT`）、`code` 唯一索引、`quantity Decimal(14,3)`。
- 因此本阶段**无需在生产执行任何迁移**；只需替换后端与后台镜像。

---

## 十一、部署与回滚说明

### 11.1 部署顺序（重要）

后端 DTO 与后台表单是**成对变更**：

- 旧后台 + 新后端：旧后台不发送 `inventory`，新后端按"不触碰库存"处理 → 兼容，可先发后端。
- 新后台 + 旧后端：新后台会发送 `inventory` / `removeInventory`，旧后端 `forbidNonWhitelisted` 会返回 400 → **不可接受**。

因此必须**先发后端、再发后台**，且后台发布窗口内不要保留旧后台实例对外服务（或接受该窗口内订单表单报 400 的风险）。推荐：后端与后台在同一发布窗口内滚动更新。

### 11.2 回滚

- 后端回滚到 `df6ff29` 之前版本、后台回滚到 `78af49a` 之前版本即可；无数据迁移需要回滚。
- 回滚后，本阶段通过订单表单创建的库存**仍然存在且数据正确**（只是旧版订单表单不再展示它们），无脏数据。

### 11.3 发布前检查清单

- [ ] 后端 `npm run build` + `start:prod` 正常
- [ ] 后台 `npm run build` + `start` 正常
- [ ] 生产库 `inventory_items` 表已存在（Phase 5.3 迁移已执行）
- [ ] `SALES` 角色具备 `inventory.read/create/update/delete`（`seed-rbac.ts` 已包含）
- [ ] 发布后手工验证：新建订单选「是」→ 订单详情出现关联库存 1 条

---

## 十二、结论与验收状态

**状态：COMPLETE**

- 三条需求全部实现，且都有对应的自动化验证（e2e + 真实浏览器 + 真实 HTTP）。
- 后端 27 套件 / 411 用例全绿；管理后台类型检查与构建通过；浏览器 27/27、HTTP 22/22，0 pageerror、0 console.error。
- 关键安全语义（不静默删除、不重复新增、不级联订单、越权保护）均以测试锁定，不是口头承诺。
- 无 schema 变更、无生产动作；改动已提交到本地 `261017` 分支（后端 `fca3c55`、后台 `2a983d4`），**未推送**（当前环境 GitHub 不可达）。

### 交付物清单

| 类型 | 路径 |
| --- | --- |
| 最终报告 | `bailing-backend/docs/phase-5.3.2-order-inventory-ux-final-report.md` |
| 浏览器验收脚本 | `docs/phase-5.3.2-browser/browser-acceptance.mjs` |
| 浏览器验收结果 | `docs/phase-5.3.2-browser/browser-results.json` |
| 浏览器截图（12 张） | `docs/phase-5.3.2-browser/screenshots/` |
| HTTP 集成脚本 | `docs/phase-5.3.2-browser/http-integration.mjs` |
| 后端新增测试 | `bailing-backend/test/order-inventory-link.e2e-spec.ts`、`test/inventory-support.spec.ts` |
