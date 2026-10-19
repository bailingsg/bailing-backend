# Phase 5.3.3 生产发布准备与安全部署验证 · 只读审计报告

> 执行时间：2026-10-19 10:00–10:30 (GMT+8)
> 执行方式：**只读审计**（未执行任何生产变更）
> 范围：`bailing-backend` + `bailing-admin`；`bailing-ui` 本次未改动
> 生产目标：`43.159.152.116`（腾讯云，美国硅谷）

## 结论先行

| 项 | 结论 |
| --- | --- |
| 只读审计本身 | **COMPLETE** |
| 生产发布建议 | **BLOCKED FOR PRODUCTION RELEASE** |
| 本阶段是否发生生产变更 | **否**（零变更） |

阻断原因（P0）：SSH 管理通道不可用；生产备份与恢复能力未经验证；线上运行的确切镜像标签无法确认，因而**没有可确认的回滚目标**。

> 本报告状态词说明：
> `PASS` = 有直接证据验证通过；`FAIL` = 有直接证据确认失败；
> `BLOCKED` = 因权限/网络/前置条件无法检查；`UNVERIFIED` = 证据不足，不下结论；
> `N/A` = 确实不适用并说明理由。
> 特别注意：**"未发现问题"不等于"已经证明安全"**。

---

## 一、执行摘要

Phase 5.3.2（订单-库存同事务联动、库存列表操作列改造）的代码已在本地与远端仓库完成并一致。审计发现三个关键事实：

1. **生产后端版本落后两个阶段。** 线上后端实际运行基线为 `e1cac24`（2026-10-17 16:31），包含 Phase 5.1/5.2 的 `cms/orders`、`cms/samples`，但**不含 Phase 5.3 的 `cms/inventory`**。直接证据：公网探测 `/api/v1/cms/inventory` 返回 **404**，而 `/cms/orders`、`/cms/samples` 返回 401（路由存在、缺令牌）。
2. **生产后台版本落后三个阶段。** 线上后台基线为 `77c869b`（2026-10-17 15:55），页面清单中**没有任何 orders / samples / inventory 页面**。即：线上管理员目前看不到订单与库存功能。
3. **发布顺序不可调换。** 新后台（`2a983d4`）创建/编辑订单时会发送 `code` 与 `inventory`；旧后端（`e1cac24`）的 DTO 没有这两个字段，且全局 `ValidationPipe` 配置了 `whitelist: true, forbidNonWhitelisted: true`，必然返回 **HTTP 400**。因此必须**先发布后端、再发布后台**，且两步骤之间不应保留旧后台对外服务。

另有两项必须在发布前解决：

- 生产数据库缺少迁移 `20261018093000_add_inventory_items`（唯一待应用迁移，纯增量）。
- 生产 `SALES` 角色**必然缺少** `inventory.read/create/update/delete` 权限（这些权限直到 `66ef13c` 才进入 registry 与 seed-rbac）。

---

## 二、检查范围与未检查范围

### 2.1 已检查（有证据）

| 编号 | 检查项 | 方式 | 状态 |
| --- | --- | --- | --- |
| A1 | 两仓库工作区、分支、rebase/merge 状态 | 本地 git | PASS |
| A2 | 三个提交的存在性、完整 SHA、父提交、分支归属 | 本地 git | PASS |
| A3 | 本地与远端一致性 | `git ls-remote` + `rev-parse` 比对 | PASS |
| A4 | RFQ 未提交改动保护 | `git status --short` | PASS |
| A5 | 前后端字段兼容性（10 项） | 读当前代码 + 历史 DTO 对比 | PASS |
| A6 | 5.3.2 是否引入 schema 变更 | `git diff -- prisma` | PASS（无变更） |
| A7 | 生产公网服务状态 | HTTP 探测 + TCP 探测 | PASS |
| A8 | Dockerfile / .dockerignore / 健康检查 / 运行用户 / 环境变量 | 读构建文件 | PASS |
| A9 | 迁移目录与唯一待应用迁移 | `git ls-tree` + 读 SQL | PASS |
| A10 | `inventory.*` 权限引入时点 | `git log -S` | PASS |

### 2.2 未检查（无法检查，已如实标记）

| 编号 | 检查项 | 状态 | 原因 |
| --- | --- | --- | --- |
| B1 | 服务器主机名/系统/内存/磁盘/uptime | BLOCKED | SSH 22 端口超时 |
| B2 | `docker ps` / `docker images` / `docker inspect` | BLOCKED | 同上 |
| B3 | `nginx -T` 实际配置 | BLOCKED | 同上 |
| B4 | `ufw status verbose` / `fail2ban-client status sshd` | BLOCKED | 同上 |
| B5 | 生产数据库 `_prisma_migrations` 表实际内容 | BLOCKED | 同上 |
| B6 | 生产备份文件、时间、保留策略、可恢复性 | BLOCKED | 同上 |
| B7 | 线上运行镜像的确切 ID / 标签 | BLOCKED | 同上 |
| B8 | 生产 `role_permissions` 中 SALES 的实际权限集 | UNVERIFIED | 同上（见 C4 推断） |
| B9 | 生产 `orders.code` 现有数据的空值/重复情况 | BLOCKED | 同上 |
| B10 | 已执行恢复演练 | UNVERIFIED | 无证据 |

**未做检查的原因不是意愿，而是通道**：本机公网出口 IP 为 `60.210.245.253`，而历史记录中 UFW 仅放行 `60.210.239.23`。三次 TCP 22 探测与一次真实 SSH 均返回 `Connection timed out`（超时，非拒绝、非认证失败），说明是网络层被拦截，而非服务器宕机——同一时刻 TCP 80 正常，`/api/v1/health` 正常返回。

本阶段**未修改** UFW、安全组、SSH 配置，也未尝试以开放全网访问的方式绕过。

---

## 三、Git 版本核验表

### 3.1 工作区状态

| 仓库 | 路径 | 分支 | HEAD | 工作区 | 进行中状态 |
| --- | --- | --- | --- | --- | --- |
| bailing-backend | `D:/com.bailingwooden/bailing-backend` | `261017` | `52aeb4d` | **干净**（0 改动） | 无 rebase/merge/cherry-pick |
| bailing-admin | `D:/com.bailingwooden/bailing-admin` | `261017` | `2a983d4` | 仅 2 个文件改动（用户 RFQ 改动） | 无 rebase/merge/cherry-pick |

后台工作区改动（**只读取、未修改、未提交、未还原**）：

```
 M src/app/(dashboard)/rfq/page.tsx
 M src/lib/rfq.ts
```

### 3.2 提交核验

| 报告提交 | 仓库 | 完整 SHA | 父提交 | 日期 | 主题 | 本地存在 | 远端一致 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fca3c55` | backend | `fca3c55b26fa0efd20fd6205ac1bee99ce3d72ae` | `df6ff29bf99ddebd1c839a36ef3ce38a07dab813` | 2026-10-19 09:50:31 +0800 | feat(orders): 订单与库存同事务联动（Phase 5.3.2 后端） | 是 | 是 |
| `52aeb4d` | backend | `52aeb4d6dfa43456e1180bc8c86650e7d0b67640` | `fca3c55b26fa0efd20fd6205ac1bee99ce3d72ae` | 2026-10-19 09:51:16 +0800 | docs(phase5.3.2): 订单-库存联动 UX 改造最终报告 | 是 | 是 |
| `2a983d4` | admin | `2a983d44a9285aca0288cc88a8a341fff8c8d51b` | `78af49ac6f476397bc71a7c5e941634a594d671f` | 2026-10-19 09:50:41 +0800 | feat(admin): 订单库存联动表单 + 库存列表操作列改造（Phase 5.3.2） | 是 | 是 |

远端核验：`git ls-remote origin refs/heads/261017`

- backend 远端 = `52aeb4d6dfa43456e1180bc8c86650e7d0b67640` → 与本地 HEAD **MATCH**
- admin 远端 = `2a983d44a9285aca0288cc88a8a341fff8c8d51b` → 与本地 HEAD **MATCH**

补充说明：`261017` 分支**未配置 upstream**（因此状态行不显示 ahead/behind），推送需显式指定 refspec；这一点不影响本次版本核验结论，但发布脚本需注意。`master` / `dev` 均为 `44497f7`（Phase 4.x 时代），**不是**发布基线。

### 3.3 改动文件清单（用于确认发布内容）

`fca3c55`（7 文件，+787/-69）：

```
src/modules/inventory/inventory.service.ts        |  33 +--
src/modules/inventory/inventory.support.ts        |  44 +++   （新增）
src/modules/orders/dto/order-inventory.dto.ts     |  51 +++   （新增）
src/modules/orders/dto/orders.dto.ts              |  25 ++
src/modules/orders/orders.service.ts              | 266 +++++---
test/inventory-support.spec.ts                    |  45 +++   （新增）
test/order-inventory-link.e2e-spec.ts             | 392 ++++++ （新增）
```

`52aeb4d`（1 文件，+291）：仅报告文档。

`2a983d4`（后端无涉；后台侧见 Phase 5.3.2 最终报告第七节）。

---

## 四、后端与后台兼容矩阵

### 4.1 事实基础（逐条有证据）

| # | 兼容项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 新后台创建订单时发送 `code` | 是 | `order-form.tsx:262` `code: code.trim()` |
| 2 | 新后台创建/编辑时发送 `inventory` | 是 | `order-form.tsx:263 / :267` `inventory: inventoryPayload` |
| 3 | 新后台发送 `removeInventory` | 是（仅用户确认删除后） | `order-form.tsx:269` `removeInventory: removalConfirmed \|\| undefined` |
| 4 | 后端 DTO 接受 `code`/`inventory`/`removeInventory` | 是 | `orders.dto.ts:147 / :138 / :166` |
| 5 | 订单与库存在同一事务写入 | 是 | `orders.service.ts:236-262` `this.prisma.$transaction(async (tx) => { order.create + inventoryItem.create })` |
| 6 | 库存字段校验失败时订单回滚 | 是 | 同事务 + e2e `库存字段非法时整体失败：订单不落库` |
| 7 | 重复订单号返回 409 | 是 | `orders.service.ts:222-227` 预检 + P2002 → `ConflictException` |
| 8 | 修改已有库存更新原记录（不重复新增） | 是 | `orders.service.ts` update 分支：`primary` 非空走 `update`，无则 `create` |
| 9 | 「是」改「否」必须明确确认 | 是 | `order-form.tsx:212-215` 未确认时 `validate()` 返回错误并阻止提交 |
| 10 | `inventory` 与 `removeInventory` 同传被拒 | 是 | `orders.service.ts:343-344` → 400 |
| 11 | 删除库存不级联订单 | 是 | e2e `删除库存记录：订单与其它数据不受影响`；FK `ON DELETE RESTRICT` |
| 12 | 权限/归属/越权校验保留 | 是 | `orders.service.ts` 沿用 `isAdmin` + `salespersonId !== actor.id` → 403；库存联动以**订单编辑权限**为授权依据 |

### 4.2 兼容矩阵

| 后端版本 | 后台版本 | 预期兼容性 | 风险说明 | 证据 |
| --- | --- | --- | --- | --- |
| `e1cac24`（线上基线） | `77c869b`（线上基线） | 兼容 | 现网生产基线。后台无订单/库存页面，不存在表单提交冲突 | 页面清单为空 |
| `e1cac24` | `2a983d4`（新后台） | **不兼容（FAIL）** | 旧后端 DTO 无 `code`、无 `inventory`，`forbidNonWhitelisted` → 订单保存 **400**；且 `/cms/inventory` 404 | `git show e1cac24:...orders.dto.ts` 无 `code` |
| `52aeb4d`（新后端） | `77c869b`（旧后台） | **兼容（PASS）** | 旧后台不提交订单表单；`inventory`/`removeInventory` 均为可选字段，缺失即"不触碰库存" | DTO 字段 `@IsOptional()` |
| `52aeb4d` | `78af49a`（5.3 后台） | 兼容 | 5.3 后台发送 `code` 但不发送 `inventory`；新后端兼容 | `git show 78af49a:...order-form.tsx:134` |
| `52aeb4d` | `2a983d4`（新后台） | 兼容（PASS） | 目标发布组合，已由 e2e / 浏览器 27/27 / HTTP 22/22 验证 | Phase 5.3.2 报告 |

**关键推论**：唯一失败组合是「新后台 + 旧后端」。因此发布必须是**后端先行**；一旦先发后台，线上订单保存会全面 400，属业务中断级故障。

---

## 九、风险清单

### 9.1 P0（阻断发布）

#### P0-1 SSH 管理通道不可用，无法监控与回滚

- 证据：TCP 22 三次探测 + 一次真实 SSH 均 Connection timed out；本机出口 IP 60.210.245.253；历史白名单为 60.210.239.23。同一时刻 TCP 80 与 HTTP 健康检查正常，排除服务器宕机。
- 影响范围：发布后无法查看容器状态、无法查看日志、无法执行回滚、无法确认迁移结果。**等于在没有任何可观测性与回滚手段的情况下变更生产。**
- 发布前必须采取的措施：按 6.4 节方案 A 在腾讯云安全组放行当前办公 IP 的 22 端口，并完成只读登录验证。
- 验证方式：`ssh -i <key> ubuntu@<ip> 'hostname; date -Is; uptime'` 成功。
- 回滚方式：删除该安全组规则。

#### P0-2 生产备份与恢复能力未经验证

- 证据：无 SSH 通道，无法查看备份目录、文件时间、保留策略；无恢复演练证据。
- 影响范围：迁移或代码故障导致数据异常时无恢复手段。
- 发布前必须采取的措施：完成一次真实备份并**执行恢复演练**（恢复到临时库验证表与行数），保存备份文件路径与校验值。
- 验证方式：恢复演练成功，且能比对关键表行数（orders / order_attachments / admin_users / inventory_items）。
- 回滚方式：从演练验证过的备份恢复。

#### P0-3 线上运行的确切镜像标签无法确认，因而没有可确认的回滚目标

- 证据：历史记录指向 backend=e1cac24、admin=77c869b、frontend=fb67cf6，且 `e1cac24` 的代码内容与线上路由探测完全吻合；但无法执行 docker inspect 确认镜像 ID。镜像标签可能被重复构建覆盖。
- 影响范围：若新版本故障，无法确定回滚到哪一个镜像。
- 发布前必须采取的措施：在发布**之前**先记录当前镜像（见 10.2 节命令），并确认该标签对应的 commit。
- 验证方式：`docker inspect` 输出的镜像 ID 与 `git rev-parse` 能对应。
- 回滚方式：切回已记录的镜像标签。

#### P0-4 生产数据库缺少待应用迁移，且实际迁移状态无法确认

- 证据：`/api/v1/cms/inventory` 返回 404 说明线上后端无 Phase 5.3；`e1cac24` 树中无 `inventory_items` 建表迁移；唯一待应用迁移为 `20261018093000_add_inventory_items`。但生产 `_prisma_migrations` 表的实际内容**无法读取**。
- 影响范围：若生产库已存在 `inventory_items` 表而迁移未登记，`prisma migrate deploy` 会因对象已存在而失败；若表不存在而直接发布新后端，库存接口将 500。
- 发布前必须采取的措施：只读查询 `_prisma_migrations` 最后一条记录与 `inventory_items` 表是否存在，二选一处理后再决定迁移动作。
- 验证方式：查询结果明确（表存在且迁移已登记 / 表不存在且迁移未登记）。
- 回滚方式：该迁移为纯增量，回滚即删除表与索引（仅在确认无业务数据时）。

#### P0-5 发布顺序错误将造成订单保存全面失败

- 证据：4.2 矩阵中新后台 + 旧后端为唯一失败组合，原因为 `forbidNonWhitelisted` 拒绝 `code`、`inventory`。
- 影响范围：订单创建/编辑 100% 失败，属业务中断。
- 发布前必须采取的措施：严格按 10.1 节顺序执行，禁止先发后台。
- 验证方式：后端发布后先用旧后台验证核心 CMS 功能未回归，再发后台。
- 回滚方式：回滚后台镜像即可恢复（后端保持新版兼容旧后台）。

### 9.2 P1（发布前必须解决或形成明确控制）

#### P1-1 生产 SALES 角色缺少 inventory 权限（本次审计最需要在发布前解决的功能性阻断）

- 证据：`inventory.read / create / update / delete` 直到提交 `66ef13c`（Phase 5.3）才同时写入 `src/modules/rbac/permission.registry.ts` 与 `prisma/seed-rbac.ts`（`seed-rbac.ts` 该提交 +5 行）。生产基线为 `66ef13c` 的祖先 `e1cac24`，其角色权限集不可能包含这四项。线上 `/cms/inventory` 404 只是后端还没有该模块；一旦发布新后端，**权限缺失会立刻显形**。
- 影响范围：所有 SALES 角色账号登录后台后看不到库存导航、调用库存接口 403；管理员（SUPER_ADMIN）不受影响。
- **发布前必须采取的措施：在生产数据库执行 `seed-rbac`（幂等 upsert）。这是对生产 `role_permissions` 表的写操作，必须单独经用户批准，本阶段未执行。**
- 验证方式：只读查询 `role_permissions` join `permissions`，确认 SALES 角色含 4 条 inventory 权限；或以 SALES 账号登录后台可见库存入口。
- 回滚方式：`seed-rbac` 仅 upsert 不改动其它角色权限，无需回滚；如需回退，删除新增的 4 条 role_permissions 关联行即可（不建议，会导致功能不可用）。

#### P1-2 迁移需要独立的 tools 镜像

- 证据：runtime 镜像仅 COPY `prisma` 目录，未安装 prisma CLI；历史记录显示生产用 `bailing-backend:tools-<commit>` 镜像执行迁移。
- 影响范围：发布步骤比普通替换容器多一步，且 tools 镜像需要额外磁盘空间。
- 措施：在发布计划中显式包含 tools 镜像的构建与执行步骤。
- 验证方式：`prisma migrate deploy` 输出 "No pending migrations" 或成功应用 1 个迁移。

#### P1-3 后台 API 基址在构建期硬编码为 IP，且全站无 HTTPS

- 证据：`bailing-admin/Dockerfile` 中 `ARG NEXT_PUBLIC_API_BASE_URL="http://43.159.152.116/api/v1"`；线上 443 不通。
- 影响范围：JWT 与登录凭据经明文 HTTP 传输；后续若启用域名或 TLS，后台必须**重新构建**才能更换基址。
- 措施：本次发布沿用现有 IP 基址（不引入新变量），但把"启用域名 + HTTPS"列为独立后续任务；在启用 TLS 前，建议限制后台入口来源 IP。
- 验证方式：发布后确认后台能正常登录并调用接口。

#### P1-4 容器健康检查不覆盖下游依赖

- 证据：后端 HEALTHCHECK 请求 `/api/v1/health`（liveness，不连 DB）；后台 HEALTHCHECK 请求 `/`（无后端也返回 200）。
- 影响范围：数据库故障时后端容器仍显示 healthy，值班容易误判；后台健康状态不能反映后端可用性。
- 措施：改用 `/api/v1/health/ready` 作为后端健康检查（改动 Dockerfile，需重新构建镜像，可作为本次发布的一项小改进，也可放到下一迭代）。
- 验证方式：停掉数据库后观察容器状态是否变为 unhealthy。

#### P1-5 订单与库存的事务一致性尚未在目标生产版本验证

- 证据：一致性由 Phase 5.3.2 的 e2e 与 HTTP 集成在测试库验证，未在生产验证。
- 影响范围：若生产 PostgreSQL 版本与测试库不一致（历史记录生产为 postgres:16，本地 compose 为 postgres:17-alpine），极端情况下行为可能有差异。
- 措施：发布后按第十一节冒烟清单验证"库存字段非法时订单回滚"与"重复订单号 409 不产生残留"。
- 验证方式：使用专用测试账号在隔离数据上执行（见 11.2）。

#### P1-6 一订单多库存仅靠应用层保证"主库存"唯一

- 证据：主库存定义为 `createdAt asc, id asc` 的第一条，由 `OrdersService.update` 与前端 `pickPrimaryInventory` 一致实现；数据库无部分唯一索引约束。
- 影响范围：极高并发下理论上可能产生两条主库存，导致订单表单只编辑其中一条、另一条被忽略。
- 措施：本次不加数据库约束（避免 schema 变更扩大发布面）；在监控中关注一订单多库存的记录数。
- 验证方式：发布后 SQL 统计按 orderId 分组的库存条数分布。

### 9.3 P2（非阻断项）

| 编号 | 问题 | 证据 | 说明 |
| --- | --- | --- | --- |
| P2-1 | favicon 404 | Phase 5.3.1 浏览器验收记录 | 不影响业务，可后续补图标 |
| P2-2 | 本地 compose 用 postgres:17-alpine，生产记录为 postgres:16 | 两处 compose 文件对比 | 环境漂移，建议统一；本次不影响发布 |
| P2-3 | 后台镜像构建上下文偏大 | admin Dockerfile `COPY . .`，.dockerignore 未排除 docs 等 | 镜像体积问题，非安全问题 |
| P2-4 | 261017 分支未配置 upstream | `git status --branch` 无 ahead/behind | 发布脚本需显式 refspec，否则易误判 |
| P2-5 | 基础镜像仅固定 major（node:22-alpine），未固定 digest | 两个 Dockerfile | 可重复性受上游 tag 影响，建议后续固定 digest |
| P2-6 | 库存无软删除/回收站 | 代码为硬删 + 审计日志 | 误删后不可恢复，需靠审计日志追溯 |

---

## 十、推荐部署顺序（命令草案，需用户单独批准后执行）

### 10.1 顺序与理由

按 4.2 矩阵，"新后台 + 旧后端"是唯一失败组合，因此顺序为：**数据库迁移 → 后端 → 权限 seed → 后台**。严禁先发后台。

| 步骤 | 动作 | 前置条件 | 验证 |
| --- | --- | --- | --- |
| 0 | 记录当前状态（镜像 ID、容器状态、nginx 配置备份） | SSH 通道可用 | 记录文件已保存 |
| 1 | 完成生产备份 + 恢复演练 | 步骤 0 完成 | 恢复演练通过（P0-2） |
| 2 | 只读查询 `_prisma_migrations` 最后一条与 `inventory_items` 是否存在 | 步骤 1 完成 | 明确两种情形之一 |
| 3 | 执行 `prisma migrate deploy`（应用 1 个增量迁移） | 步骤 2 确认表不存在 | `inventory_items` 表 + 8 个对象存在 |
| 4 | 构建并推送新后端镜像 `bailing-backend:52aeb4d` | 步骤 3 完成 | 镜像构建成功 |
| 5 | **用 tools 镜像在生产执行 `seed-rbac`** | 步骤 4 完成后端未切流量前 | SALES 角色含 4 条 inventory 权限 |
| 6 | 发布新后端（替换容器，restart=unless-stopped） | 步骤 5 完成 | `/health` 200、`/health/ready` database:true |
| 7 | 回归旧后台（77c869b）核心 CMS：产品、博客、媒体、询盘 | 步骤 6 完成 | 各列表可打开、可保存 |
| 8 | 构建新后台镜像 `bailing-admin:2a983d4`（build-arg 用现有 IP 基址） | 步骤 7 通过 | 构建成功 |
| 9 | 发布新后台 | 步骤 8 完成 | 登录正常、导航含库存管理/订单管理 |
| 10 | 冒烟测试（第十一节） | 步骤 9 完成 | 全部通过 |
| 11 | 观察窗口（建议不少于 30 分钟）后宣布完成 | 步骤 10 完成 | 无错误日志激增 |

关于步骤 6/9 之间是否保留旧后台对外服务：**推荐不留空窗但也不并行**——即步骤 6 完成后旧后台继续服务（兼容），步骤 9 替换后台。由于新后端兼容旧后台，这个顺序是安全的；相反顺序不安全。

### 10.2 前置记录命令（只读，建议在步骤 0 执行）

```bash
# 记录回滚目标（务必先做，否则 P0-3 无法解除）
docker inspect --format '{{.Image}}' bailing-backend
docker inspect --format '{{.Image}}' bailing-admin
docker inspect --format '{{.Image}}' bailing-frontend
docker ps --no-trunc --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

# 迁移状态（只读）
docker exec bailing-postgres psql -U <user> -d <db> -c \
  "select migration_name, finished_at from _prisma_migrations order by finished_at desc limit 5;"
docker exec bailing-postgres psql -U <user> -d <db> -c \
  "select to_regclass('public.inventory_items');"

# 权限状态（只读）
docker exec bailing-postgres psql -U <user> -d <db> -c \
  "select r.key, count(*) from role_permissions rp
   join roles r on r.id = rp.role_id
   join permissions p on p.id = rp.permission_id
   where p.key like 'inventory.%' group by r.key;"
```

### 10.3 发布命令草案（NEVER 执行 `docker compose down -v`）

```bash
# 3. 迁移（tools 镜像含 prisma CLI）
docker build -t bailing-backend:tools-52aeb4d --target build .
docker run --rm --env-file /opt/bailing/env/backend.env \
  bailing-backend:tools-52aeb4d npx prisma migrate deploy

# 5. seed-rbac（仅 upsert 角色权限，需单独批准）
docker run --rm --env-file /opt/bailing/env/backend.env \
  bailing-backend:tools-52aeb4d node dist/prisma/seed-rbac.js

# 4. 后端镜像（runtime）
docker build -t bailing-backend:52aeb4d .

# 6. 发布后端（不 down -v、不删卷）
docker stop bailing-backend && docker rm bailing-backend
docker run -d --name bailing-backend \
  --restart unless-stopped \
  --env-file /opt/bailing/env/backend.env \
  --network bailing-internal \
  -p 127.0.0.1:4000:4000 \
  bailing-backend:52aeb4d

# 8. 后台镜像（build-arg 必须指向现有公网入口）
docker build -t bailing-admin:2a983d4 \
  --build-arg NEXT_PUBLIC_API_BASE_URL=http://43.159.152.116/api/v1 .

# 9. 发布后台
docker stop bailing-admin && docker rm bailing-admin
docker run -d --name bailing-admin \
  --restart unless-stopped \
  --env-file /opt/bailing/env/admin.env \
  --network bailing-internal \
  -p 127.0.0.1:13001:3001 \
  bailing-admin:2a983d4
```

> 上述镜像名、容器名、env 文件路径与网络名以生产实际为准；步骤 0 的记录结果为准，本草案不覆盖既有配置。**本阶段未执行其中任何一条。**

---

## 十一、发布后验证方案

### 11.1 只读验证（发布后可立即执行，不写生产数据）

| 编号 | 用例 | 期望 |
| --- | --- | --- |
| V1 | `GET /`（首页）与主要栏目页 | 200，无 5xx |
| V2 | `GET /api/v1/health`、`/api/v1/health/ready` | 200，database:true |
| V3 | `GET /api/v1/cms/inventory`（带管理员令牌） | 200 且返回空列表或既有数据（不再 404） |
| V4 | `GET /api/v1/cms/orders?page=1&limit=1` | 200，分页结构正常 |
| V5 | 旧 WordPress 站 `https://bailingwooden.com/` | 200（确认未受影响） |
| V6 | 未带令牌访问 `/api/v1/cms/orders` | 401（鉴权仍生效） |
| V7 | `docker ps` 观察三个容器 healthy、restarts 未增长 | healthy，restarts=0 |
| V8 | 后端日志无 Prisma 连接错误 | 无 error 级日志 |

### 11.2 写操作验证（必须在隔离环境或使用专用测试数据与清理授权）

以下用例**会写生产数据**，不得擅自执行。执行前需：创建专用测试账号、约定数据前缀、约定清理脚本与清理授权、并在维护窗口内执行；完成后按同一前缀清理并核对行数。

| 编号 | 用例 | 期望 |
| --- | --- | --- |
| W1 | 管理员与 SALES 分别登录后台 | 均能登录；SALES 可见库存入口 |
| W2 | SALES 打开订单列表、详情、按订单号搜索 | 200，数据正确 |
| W3 | 新建订单不填订单号直接保存 | 前端拦截或后端 400（取决于前端校验先触发） |
| W4 | 新建订单填写唯一订单号 + 「是否有库存？是」+ 合法库存字段 | 201，订单详情「关联库存」为 1 条 |
| W5 | 再次提交同一订单号 + 库存 | 409，且库存条数不增加 |
| W6 | 编辑该订单，把库存数量改为非法值（如 1.2345） | 400，订单字段未被修改（事务回滚） |
| W7 | 编辑该订单，「是」改「否」但未点确认删除就保存 | 前端提示需确认，订单与库存均不变 |
| W8 | 编辑该订单，确认删除库存后保存 | 200，关联库存归零，订单仍存在 |
| W9 | 库存列表行内「删除」 | 二次确认弹窗含编号/产品/数量/位置；确认后列表刷新、无跳转 |
| W10 | 删除 W4/W8 产生的库存后查看订单详情 | 订单仍在，字段完好 |
| W11 | 业务员甲尝试访问业务员乙的库存详情 | 404（不泄漏存在性） |
| W12 | 移动端视口检查库存列表与订单表单 | 无横向溢出 |
| W13 | 清理所有 W 系列测试数据并核对 orders / inventory_items 行数 | 恢复到测试前基线 |

---

## 十二、回滚方案

### 12.1 后端回滚

| 项 | 内容 |
| --- | --- |
| 上一版本镜像 | **需在发布前通过 `docker inspect --format '{{.Image}}' bailing-backend` 记录**。历史记录指向 `e1cac24`，但未经本次确认 |
| 配置备份位置 | 发布前先 `cp /opt/bailing/env/backend.env /opt/bailing/env/backend.env.bak.<date>`（需用户执行） |
| 回滚命令草案 | `docker stop bailing-backend && docker rm bailing-backend`，再以**同一份 env 文件**与**同一套端口/网络参数**启动旧镜像 |
| 回滚后健康检查 | `/api/v1/health` 200、`/health/ready` database:true、前台 `/` 200、`/api/v1/products` 200 |
| 是否需同步回滚数据库 | **不需要**。新增迁移为纯增量（新表 + 索引 + 外键），回滚代码不影响已有表 |
| 回滚后订单与库存是否可能不一致 | 理论上：若发布窗口内已通过新后台创建了带库存的订单，回滚后台后这些库存记录仍存在但无界面可管理；订单本身完好。**建议：若必须回滚后台，先确认窗口期内是否产生库存写入；如有，保留后端新版本或另行处理，不要只回滚后台** |

### 12.2 后台回滚

| 项 | 内容 |
| --- | --- |
| 上一版本镜像 | **需在发布前记录**。历史记录指向 `77c869b` |
| 回滚命令草案 | 同 12.1，容器 `bailing-admin`，端口 `127.0.0.1:13001:3001` |
| 回滚后健康检查 | 登录页 200、登录成功、导航与各 CMS 列表正常 |
| 是否需同步回滚数据库 | 不需要 |
| 注意事项 | 单独回滚后台到旧版是安全的（新后端兼容旧后台）；**单独回滚后端而不回滚后台不安全**（新后台会 400） |

### 12.3 明确禁止的回滚方式

- 禁止 `docker compose down -v`、删除数据库卷、清空或重建数据库。
- 禁止 `prisma migrate reset`、`prisma db push`。
- 禁止用"删表"方式回滚迁移，除非已确认 `inventory_items` 无业务数据且已备份。

### 12.4 如果没有任何可确认的旧镜像

若步骤 0 无法记录到旧镜像（例如 SSH 仍不通），则**发布必须标记为 BLOCKED**——在无可回滚目标的前提下不得变更生产。这正是本报告当前结论为 BLOCKED 的原因之一。

---

## 十三、阻塞事项与用户需要人工完成的事项

### 13.1 必须由用户完成（本阶段无法代做）

| 优先级 | 事项 | 具体动作 | 完成标志 |
| --- | --- | --- | --- |
| P0 | 放行 SSH | 腾讯云控制台 → 安全组 → 入站规则 → 新增 TCP 22，来源填当前办公出口 IP（本次实测 `60.210.245.253`，**单 IP 而非 0.0.0.0/0**） | `ssh ... 'hostname; uptime'` 成功 |
| P0 | 备份与恢复演练 | 在生产执行备份，并恢复到临时库验证 | 恢复演练通过并留档 |
| P0 | 记录当前镜像 ID | 执行 10.2 节命令并保存输出 | 三个容器的镜像 ID 已记录 |
| P0 | 确认迁移状态 | 只读查询 `_prisma_migrations` 与 `inventory_items` 存在性 | 结论明确 |
| P1 | 批准 seed-rbac | 审批在生产执行 `seed-rbac`（写 `role_permissions`） | 已批准并在窗口期内执行 |
| P1 | 确认发布窗口 | 约定维护窗口与值班人 | 已约定 |

### 13.2 本阶段被阻塞、未取得的证据

服务器主机信息、容器与镜像元数据、nginx 实际配置、UFW/fail2ban 状态、生产迁移表内容、备份文件与保留策略、生产角色权限实际内容、`orders.code` 现有数据质量、恢复演练记录。上述项目在 SSH 通道恢复后应按 10.2 与第 6.4 节补齐，再重新评估发布条件。

---

## 十四、最终结论

### 14.1 状态

| 维度 | 结论 |
| --- | --- |
| 只读发布准备审计 | **COMPLETE** |
| 生产发布建议 | **BLOCKED FOR PRODUCTION RELEASE** |
| 本阶段是否发生生产变更 | **否** |

### 14.2 为什么是 BLOCKED

1. **P0-1** SSH 管理通道不可用 → 发布后无法监控、无法回滚。
2. **P0-2** 备份与恢复能力未经验证 → 无数据安全网。
3. **P0-3** 线上确切镜像标签无法确认 → 没有可确认的回滚目标。
4. **P0-4** 生产迁移状态无法确认，且发布前必须先应用 1 个增量迁移。
5. **P1-1** 生产 SALES 角色缺 `inventory.*` 权限，发布后业务员将无法使用库存功能（需单独批准的执行动作）。

### 14.3 已经证明为"可以做"的部分

- Phase 5.3.2 代码在本地与远端**完全一致**，工作区除用户 RFQ 改动外干净，无 schema 变更，无新环境变量依赖。
- 兼容矩阵有代码级证据：新后端**向后兼容**旧后台；唯一失败组合是新后台 + 旧后端，因此"先后端、后后台"是正确且安全的顺序。
- 唯一待应用迁移为纯增量，可回滚。
- 公网侧当前安全态势符合设计：后台、后端、数据库均未直接暴露公网，HTTPS 未启用（既有问题，非本次引入）。
- 旧 WordPress 站与企业邮箱未受影响（域名在 Cloudflare，未指向 VPS）。

### 14.4 一句话总结

**代码已就绪、顺序已明确、迁移已审计；缺的不是代码，而是可管理的生产通道与经过验证的备份。** 在这两项补齐之前，不建议执行任何生产变更。

---

## 附：本报告的执行方式说明

本报告所有结论来自以下只读动作，未对生产执行任何写操作：

- 本地 `git` 只读命令（status / log / rev-parse / ls-tree / show / diff / ls-remote）
- 生产公网 TCP 探测与 HTTP GET 探测（未使用任何写方法）
- 读取本地仓库构建文件（Dockerfile / .dockerignore / compose / schema / 迁移 SQL / 源码）

**未执行**：SSH 登录生产、docker 任何命令、数据库任何连接、迁移、seed、镜像构建与上传、容器重启、nginx/DNS/防火墙/安全组变更、git reset/clean/force push、未提交 RFQ 文件的任何改动。
