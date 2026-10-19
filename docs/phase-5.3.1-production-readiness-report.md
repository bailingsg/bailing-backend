# Phase 5.3.1 生产就绪报告（部署前检查）

- **阶段**：Phase 5.3.1 — 浏览器验收与生产部署前检查（第二部分：生产只读检查 + 部署方案）
- **执行时间**：2026-10-19 08:03 – 09:05（GMT+8）
- **执行范围**：**仅只读检查与方案设计。未部署、未迁移、未重启容器、未改 DNS/邮箱/防火墙/安全组。**
- **阶段状态**：`BLOCKED`
  - 阻塞原因：生产服务器 SSH 22 端口被 UFW 白名单拦截（仅放行历史 IP `60.210.239.23`，当前出口 IP `60.210.245.253`），服务器内部与数据库侧的只读核查**未能执行**。
  - 已完成：公网侧可观测项、代码级兼容性分析、迁移安全性分析、部署与回滚方案。
  - 说明：用户已选择「临时放行当前 IP」，但截至本报告生成时放行尚未生效（连续重试 10+ 次，均 TCP 超时）。

---

## 一、结论摘要

| 判断项 | 结论 |
| --- | --- |
| 生产站点是否在线 | **在线**（80 端口 200，`/api/v1/health` 200，`ready` 数据库连通 true） |
| 生产已部署到哪个阶段 | **Phase 5.1/5.2**（订单、样品路由存在）；**Phase 5.3 库存未部署**（`/cms/inventory` 返回 404） |
| 待执行迁移数量 | **1 个**（`20261018093000_add_inventory_items`），前提是生产已应用 5.1 的迁移（证据支持，需 SSH 最终确认） |
| 迁移是否破坏性 | **否**。纯新增表 + 索引 + 外键，无 `ALTER`/`DROP` 现有表，无数据回填 |
| 新版启动是否自动迁移 | **否**。Dockerfile `CMD ["node","dist/main.js"]`，无 entrypoint、无自动 `migrate deploy` |
| 新旧版本能否共存 | **订单创建双向不兼容**：旧 admin 不传 `code` → 新后端 400；新 admin 传 `code` → 旧后端 400（`forbidNonWhitelisted`）。必须**后端与 admin 同时切换** |
| RBAC 是否需额外操作 | **需要**。生产 `SALES` 角色需补 `inventory.*` 权限，否则业务员看不到库存入口/403 |
| 是否存在阻止部署的 P0 | **是（流程性）**：SSH 未放行导致生产数据库迁移状态未核实；在此状态执行迁移属于盲操作，**禁止** |
| 备份与回滚是否充分 | 备份机制存在（每日 03:00，7 天保留），但**本次未能核实最近备份文件**；数据库回滚策略需在部署窗口内确认（见 §9） |
| 下一阶段建议 | ① 放行 SSH 后先跑只读核查清单（§12）；② 确认生产迁移记录与备份；③ 再进入部署窗口执行 §8 方案 |

---

## 二、核实边界（重要）

本报告严格区分三类信息，避免把推断当事实：

| 类别 | 说明 |
| --- | --- |
| **A. 已实测** | 通过公网 HTTP/HTTPS 探测、本地代码与 Git 分析得到的结论，可复现 |
| **B. 代码推断** | 基于仓库代码/迁移文件分析得出，逻辑确定，但生产实际文件可能不同 |
| **C. 未核实** | 必须 SSH 或数据库访问才能确认，本次**未执行**，报告中明确标注 |

### 服务器身份核实情况

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 公网 IP 可达性 | **已实测** | ICMP 通，平均 147ms |
| 是否仍为 `43.159.152.116` | **已实测（间接）** | 该 IP 80 端口返回本项目 Next.js 页面与 `/api/v1/health`，与历史部署特征一致；**腾讯云 metadata 未取到**（需 SSH） |
| 操作系统/内核 | **未核实** | 需 SSH |
| SSH 22 端口 | **已实测** | TCP 超时（UFW 白名单不含当前 IP） |

---

## 三、公网侧已实测结果（A 类）

### 3.1 站点与服务

| 探测项 | 结果 | 说明 |
| --- | --- | --- |
| `GET /` | 200，80,054 字节 | `Server: nginx` → `X-Powered-By: Next.js`，`x-nextjs-prerender: 1`，`x-nextjs-cache: HIT` |
| `GET /api/v1/health` | 200 | `{"status":"ok","uptime":142455,...}` |
| `GET /api/v1/health/ready` | 200 | `{"status":"ready","checks":{"database":true}}` → **数据库连通** |
| `GET /api/v1/public/contacts` | 200 | 公开接口正常 |
| `GET /robots.txt` | 200 | 98 字节 |
| `GET /uploads/` | 404 | 目录列表关闭（符合预期） |
| `https://43.159.152.116/` | 连接失败 | **443 未启用**（无 TLS） |
| `http://43.159.152.116:3001/` | 连接超时 | 后台端口被**腾讯云安全组**拦截（与历史记录一致） |

### 3.2 安全响应头

```
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: strict-origin-when-cross-origin
X-Powered-By: Next.js / Express
```

- 未见 `Strict-Transport-Security`（无 HTTPS，预期）
- 未见 `Content-Security-Policy`（既有状态，非本阶段引入）

### 3.3 版本探测（关键证据）

对需要鉴权的路由做无 token 请求：**路由存在返回 401，不存在返回 404**。

| 路由 | 状态 | 结论 |
| --- | --- | --- |
| `/api/v1/cms/orders` | 401 | 订单模块**已部署** |
| `/api/v1/cms/samples` | 401 | 样品模块**已部署** |
| `/api/v1/cms/roles` | 401 | RBAC 已部署 |
| `/api/v1/cms/seo/overview` | 401 | SEO 已部署 |
| `/api/v1/cms/lead-distribution` | 401 | 线索分配已部署 |
| **`/api/v1/cms/inventory`** | **404** | **库存模块未部署** |

→ **生产后端 = Phase 5.1/5.2，缺 Phase 5.3。**

### 3.4 旧网站保护状态

| 项目 | 结果 |
| --- | --- |
| `bailingwooden.com` DNS | Cloudflare（`104.21.44.46` / `172.67.194.211`） |
| `http://bailingwooden.com/` | 301（Cloudflare 跳转），**旧站仍在服务** |
| 本阶段是否触碰 | **否**，未修改任何 DNS/Cloudflare 配置 |

---

## 四、版本差距分析（B 类，基于本地 Git）

### 4.1 后端

| 项目 | 值 |
| --- | --- |
| 生产版本（历史记录） | `44497f7` fix(mail) |
| 目标版本 | `66ef13c` feat(inventory+orders)（当前分支 HEAD 为其文档后续提交 `8966d78`，代码等价） |
| 代码差异 | 21 个文件，+2857 / -44 |
| 主要变更 | 新增 `modules/inventory/*`（controller/service/dto/entity/module）、`orders` 服务与 DTO 调整、`permission.registry` 新增 inventory 权限、2 个 e2e 测试文件 |

已验证：`44497f7` 已包含 `orders`、`samples` 模块与迁移 `20261017170000_add_samples_and_orders`，与生产 401 探测结果一致。

### 4.2 Admin

| 项目 | 值 |
| --- | --- |
| 生产版本（历史记录） | `77c869b` chore(docker) |
| 目标版本 | `78af49a` feat(admin) Phase 5.3 |
| 代码差异 | 29 个文件，+4718 / -1 |
| 主要变更 | 新增 `inventory` 页面与表单、`orders` 页面/详情/照片代理、`samples` 页面、`lib/inventory.ts`/`orders.ts`/`samples.ts`、侧边栏入口 |

> **注意**：历史记录中生产 admin 镜像为 `77c869b`，早于 5.1/5.2 的 admin 界面（`aebd969`）。若属实，则生产后台目前**没有订单/样品/库存界面**，本次部署实际跨越 **5.1 + 5.2 + 5.3 三个界面版本**。该结论**必须 SSH 核实镜像 ID**（§12 清单第 2 项）。

### 4.3 UI（前台）

| 项目 | 值 |
| --- | --- |
| 本地 HEAD | `fb67cf6` |
| 本阶段是否变更 | **否**（Phase 5.3 未改前台） |
| 部署动作 | 无需重建；若镜像标签需与后端对齐，可选重建 |

### 4.4 迁移差异

本地共 16 个迁移，生产历史记录为 13 个（P0.4 时点）+ 后续 Phase 4.8/5.1 应用。待确认生产 `_prisma_migrations` 实际记录。

按探测结果推断待执行迁移：

| 迁移 | 内容 | 是否已应用（推断） |
| --- | --- | --- |
| `20261017170000_add_samples_and_orders` | samples / sample_grants / sample_requests / orders / order_attachments | **已应用**（orders 路由 401） |
| `20261018093000_add_inventory_items` | inventory_items 表 + 6 索引 + 2 外键 | **未应用**（inventory 路由 404） |

---

## 五、迁移安全性分析（B 类）

### 5.1 `20261018093000_add_inventory_items`

| 检查项 | 结果 |
| --- | --- |
| 是否 `DROP` | 否 |
| 是否 `ALTER` 现有表 | 否 |
| 是否改列类型/约束 | 否 |
| 是否数据回填 | 否 |
| 新增内容 | `CREATE TABLE inventory_items`（12 列）、6 个索引（含 `code` 唯一）、2 个外键（`orderId`→orders、`createdById`→admin_users，均 `ON DELETE RESTRICT`） |
| 锁表风险 | 仅建新表，不阻塞 `orders`/`admin_users` 读写 |
| 预计耗时 | 毫秒级（空表） |
| 回滚方式 | `DROP TABLE inventory_items`（仅在确认无库存数据后） |

### 5.2 订单号约束变化

- `orders.code` 唯一索引 `orders_code_key` **在 5.1 迁移中已建立**，Phase 5.3 **未修改结构**，仅把「系统生成」改为「业务员手动填写」。
- 因此**不需要**新增唯一索引，也**不会**因存量数据产生唯一约束冲突（前提：5.1 已应用且当时插入成功）。
- 唯一需要关注：生产存量订单的 `code` 是否均为非空且唯一 —— 由既有唯一索引保证非空唯一（`NOT NULL` + UNIQUE），**需 SSH 复核**（§12 第 7 项）。

### 5.3 数据兼容性

- 新表为空，无存量数据兼容问题。
- 旧后端代码不认识 `inventory_items` 表，存在该表也不影响其运行（Prisma 旧 schema 不引用该表）。
- **结论：迁移可先于应用发布执行，旧版本在迁移后仍可正常运行。**

---

## 六、启动行为与自动化风险（B 类）

| 检查项 | 结果 |
| --- | --- |
| 启动命令 | `CMD ["node", "dist/main.js"]` |
| 是否自动执行 `prisma migrate deploy` | **否** |
| 是否存在 entrypoint 脚本 | **否**（无 `docker-entrypoint*`） |
| 是否启动时改库 | **否**（仅连接数据库） |
| 是否 seed 自动执行 | **否** |
| 迁移失败时是否会阻止启动 | 不会自动阻止；若表缺失，访问 `/cms/inventory` 将返回 500（Prisma P2021），订单等既有功能不受影响 |

**推论**：迁移必须由部署人员**显式执行**，这降低了「误迁移」风险，但也意味着**忘记迁移会导致库存功能 500**。部署检查单必须包含迁移步骤与验证。

---

## 七、API 兼容性与新旧共存风险（B 类）

### 7.1 订单创建：双向不兼容（P1）

| 组合 | 行为 |
| --- | --- |
| 旧 admin（无 `code` 字段）+ 新后端（`code` 必填） | `POST /cms/orders` → **400**（缺少 code） |
| 新 admin（发送 `code`）+ 旧后端（DTO 无 code，`forbidNonWhitelisted: true`） | `POST /cms/orders` → **400**（未知属性 code） |
| 旧 admin + 旧后端 | 正常（系统生成订单号） |
| 新 admin + 新后端 | 正常 |

**结论**：不存在「先后端后前端」或「先前端后后端」的安全滚动窗口。**后端与 admin 必须在同一维护窗口内切换**（间隔越短越好），切换期间订单创建不可用。

### 7.2 其他接口

- 库存接口为**纯新增**，旧前端不调用，无影响。
- 订单查询新增 `code` 过滤参数：旧 admin 不传，行为不变；新 admin 传，新后端支持。
- `UpdateOrderDto` 仍不含 `code`，编辑接口不接受订单号修改（已由浏览器验收 B8 验证）。

### 7.3 RBAC 权限同步（P1）

- 新权限：`inventory`（模块）+ `inventory.read/create/update/delete`。
- `SUPER_ADMIN` 权限恒等于全集，**无需操作**。
- `SALES` 角色权限来自 `role_permissions` 表（生产已 seed 过 5.1 版本，**不含 inventory.\***）。
- 若不同步，业务员登录后：侧边栏无「库存管理」、直接访问 `/inventory` 会被拒绝。
- **必须在部署窗口执行 `prisma/seed-rbac.ts`**（幂等 upsert），或在「角色与权限」界面手动勾选。

---

## 八、生产部署方案草案（本阶段不执行）

> 所有命令按「只读检查 / 本地测试 / 生产变更」分类标注。生产变更命令仅供后续审核。

### 8.1 阶段 0：部署前准备（只读）

```bash
# [只读] 确认服务器身份
ssh ubuntu@43.159.152.116 'hostname; cat /etc/os-release | head -2; uptime'
ssh ubuntu@43.159.152.116 'curl -s http://metadata.tencentyun.com/latest/meta-data/public-ipv4'

# [只读] 容器与版本
ssh ubuntu@43.159.152.116 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"'
ssh ubuntu@43.159.152.116 'docker images | grep bailing'

# [只读] 数据库迁移状态
ssh ubuntu@43.159.152.116 'docker exec bailing-postgres psql -U bailing -d bailingwooden \
  -c "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at;"'

# [只读] 订单号数据质量
ssh ubuntu@43.159.152.116 'docker exec bailing-postgres psql -U bailing -d bailingwooden \
  -c "SELECT count(*) total, count(*) FILTER (WHERE code IS NULL) nulls FROM orders;" \
  -c "SELECT code, count(*) FROM orders GROUP BY code HAVING count(*)>1;"'

# [只读] 备份状态
ssh ubuntu@43.159.152.116 'ls -la /opt/bailing/backups/postgres | tail -5'

# [只读] 资源余量
ssh ubuntu@43.159.152.116 'df -h /; free -m'
```

### 8.2 阶段 1：数据库备份与完整性验证（生产变更 — 需审批）

```bash
# [生产变更] 备份（在服务器执行，写入备份目录）
ssh ubuntu@43.159.152.116 'sudo docker exec bailing-postgres pg_dump -U bailing -d bailingwooden \
  -Fc -f /tmp/pre-5.3.dump && sudo docker cp bailing-postgres:/tmp/pre-5.3.dump \
  /opt/bailing/backups/postgres/pre-5.3-$(date +%Y%m%d-%H%M%S).dump'

# [只读] 完整性验证（PGDMP 魔数 + 目录可读）
ssh ubuntu@43.159.152.116 'f=$(ls -t /opt/bailing/backups/postgres/pre-5.3-*.dump | head -1); \
  ls -l "$f"; head -c 5 "$f"; echo; \
  sudo docker exec bailing-postgres pg_restore -l /tmp/pre-5.3.dump | head -5'
```

**通过标准**：文件存在、大小 > 0、头部为 `PGDMP`、`pg_restore -l` 能列出对象。

### 8.3 阶段 2：迁移预检查（只读）

```bash
# [只读] 迁移将执行哪些文件（本地对比）
cd bailing-backend && npx prisma migrate status   # 本地 E2E 库验证脚本可执行性

# [只读] 生产当前迁移列表 vs 目标 16 个
# 目标：生产应有 15 条，缺 20261018093000_add_inventory_items
```

### 8.4 阶段 3：执行迁移（生产变更 — 需审批）

```bash
# [生产变更] 使用临时容器执行（沿用 P0.4 实践：public 网装 CLI，internal 网连库）
# 注意：不得使用 migrate dev / db push / reset
ssh ubuntu@43.159.152.116 'cd /opt/bailing && \
  docker run --rm --network bailing-internal \
  -e DATABASE_URL="$(grep ^DATABASE_URL env/production.env | cut -d= -f2-)" \
  -v /opt/bailing/app/backend/prisma:/app/prisma \
  -w /app node:22-alpine sh -c "npx prisma@<锁定版本> migrate deploy"'
```

风险与缓解：
- 风险：迁移执行中断 → 表可能部分创建。缓解：迁移为单事务（Prisma 默认），失败自动回滚。
- 风险：`DATABASE_URL` 泄露到命令历史。缓解：使用 `env` 文件注入，避免 `echo`；部署后清理 shell 历史。
- **验证**：`_prisma_migrations` 出现 `20261018093000_add_inventory_items` 且 `finished_at` 非空。

### 8.5 阶段 4：构建与切换镜像（生产变更 — 需审批）

```bash
# [生产变更] 源码上传（沿用 tarball 方式，排除 .env/node_modules/.git/.next/dist）
# 目标标签：backend:bailing-backend:66ef13c、admin:bailing-admin:78af49a

ssh ubuntu@43.159.152.116 'cd /opt/bailing/app/backend && \
  docker build -t bailing-backend:66ef13c .'

ssh ubuntu@43.159.152.116 'cd /opt/bailing/app/admin && \
  docker build -t bailing-admin:78af49a \
  --build-arg NEXT_PUBLIC_API_BASE_URL=http://43.159.152.116/api/v1 .'
```

**顺序建议**（最小化不可用窗口）：

1. 迁移（§8.4）— 旧版本仍可运行
2. 构建新镜像（不影响运行）
3. **同一分钟内**更新 backend 与 admin 容器（订单创建短暂不可用）
4. 立即执行健康检查与业务冒烟

```bash
# [生产变更] 容器更新（示例，实际以 compose 文件为准）
ssh ubuntu@43.159.152.116 'cd /opt/bailing && \
  docker compose up -d --no-deps backend admin && \
  docker compose ps'
```

> 注意：admin 容器必须绑定 `127.0.0.1:13001:3001`（不可 `3001:3001`，会与 nginx listen 3001 自环冲突）。

### 8.6 阶段 5：RBAC 权限同步（生产变更 — 需审批）

```bash
# [生产变更] 幂等 upsert 权限清单 + 内置角色
ssh ubuntu@43.159.152.116 'cd /opt/bailing/app/backend && \
  docker run --rm --network bailing-internal \
  -e DATABASE_URL="..." -v $PWD:/app -w /app node:22-alpine \
  sh -c "npx ts-node prisma/seed-rbac.ts"'
```

替代方案：登录后台「角色与权限」，为 `SALES` 勾选 `inventory.read/create/update/delete`。

### 8.7 阶段 6：健康检查与业务验收（只读）

```bash
# [只读] 容器健康
ssh ubuntu@43.159.152.116 'docker ps --format "{{.Names}} {{.Status}}"'

# [只读] 接口
curl -s http://43.159.152.116/api/v1/health
curl -s http://43.159.152.116/api/v1/health/ready
curl -s -o /dev/null -w "%{http_code}\n" http://43.159.152.116/api/v1/cms/inventory   # 期望 401（不再是 404）

# [只读] 页面
curl -s -o /dev/null -w "%{http_code}\n" http://43.159.152.116/
```

业务验收清单（人工，管理员 + 业务员各 1 名）：

1. 管理员登录 → 侧边栏出现「库存管理」「订单管理」
2. 新建订单：手填订单号成功；重复订单号被拒且提示清晰
3. 订单列表按订单号精确搜索命中
4. 从订单详情「新增库存」→ 订单号自动带入 → 保存后订单详情出现关联库存
5. 独立新增库存 → 列表/详情正常
6. 业务员账号：仅见本人订单与库存；URL 改他人 ID → 404
7. 移动端（手机浏览器）打开订单列表与详情，无横向溢出

### 8.8 阶段 7：部署后监控（只读）

| 指标 | 采集方式 | 阈值 |
| --- | --- | --- |
| 容器健康 | `docker ps` / healthcheck | 全部 healthy |
| API 5xx 率 | nginx access log | 5 分钟内 > 1% 告警 |
| `/health/ready` | 外部探测 1 分钟一次 | 连续 3 次失败告警 |
| 订单创建失败 | 后台日志 `POST /cms/orders` 4xx/5xx | 出现即排查 |
| 库存 500 | 后台日志 Prisma 错误 | 出现即回滚评估 |
| 磁盘 | `df -h /` | < 15% 剩余 |
| 内存 | `free -m` | 可用 < 300MB |
| 备份 | 次日 03:00 备份文件 | 缺失即告警 |

---

## 九、回滚策略

### 9.1 关键原则：应用回滚 ≠ 数据库回滚

| 层 | 可回滚性 | 说明 |
| --- | --- | --- |
| 后端镜像 | 可回滚 | 切回 `44497f7` 镜像即可 |
| admin 镜像 | 可回滚 | 切回旧镜像即可 |
| 数据库结构 | **不可通过切镜像回滚** | `inventory_items` 表会保留 |
| 数据库数据 | 需显式操作 | 仅能通过备份恢复或 `DROP TABLE` |

**旧后端在迁移后仍可运行**（不引用新表），因此「迁移成功但应用失败」时，**切回旧镜像即可恢复服务，无需回滚数据库**。这是本阶段最重要的安全属性。

### 9.2 回滚决策矩阵

| 现象 | 动作 |
| --- | --- |
| 迁移失败（事务回滚） | 不切镜像，排查后重试；服务仍为旧版本 |
| 迁移成功、新后端启动失败 | 切回旧 backend 镜像；表保留，无需清理 |
| 新后端/新 admin 业务异常（P0/P1） | 切回两个旧镜像；表保留 |
| 迁移导致 `orders` 不可用（极不可能） | 立即切旧镜像 + 用备份恢复数据库 |
| 仅 RBAC 权限未同步 | 不回滚，补跑 `seed-rbac` |

### 9.3 数据库回滚（仅在确认放弃 5.3 时）

```bash
# [生产变更 — 高危] 先确认 inventory_items 为空
ssh ubuntu@43.159.152.116 'docker exec bailing-postgres psql -U bailing -d bailingwooden \
  -c "SELECT count(*) FROM inventory_items;"'

# [生产变更 — 高危] 删除迁移记录与表（必须两步，否则 Prisma 认为已迁移）
# 顺序：DROP TABLE → DELETE FROM _prisma_migrations WHERE migration_name=...
```

**风险**：若已产生库存数据，`DROP TABLE` 将永久丢失。**默认不做数据库回滚**；保留新表不影响旧版本运行。

### 9.4 备份恢复演练建议

部署窗口前，在**独立临时库**（非生产）用最近备份做一次 `pg_restore` 演练，确认：

1. 备份可解压、可列出对象
2. 恢复后 `orders` / `admin_users` 行数与生产一致
3. 记录恢复耗时（用于评估 RTO）

---

## 十、风险清单

| 编号 | 级别 | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| R-01 | **P0（流程）** | 生产数据库迁移状态未核实即迁移 | 可能在已迁移库上重复执行（Prisma 会跳过，风险低）或在缺 5.1 迁移的库上直接建库存表导致外键失败 | **部署前必须 SSH 核查 `_prisma_migrations`**，确认 15 条且含 `20261017170000` |
| R-02 | P1 | 订单创建双向不兼容 | 切换窗口内下单 400 | 后端与 admin 同窗口切换，窗口控制在 1–2 分钟，避开业务高峰 |
| R-03 | P1 | `SALES` 角色缺 `inventory.*` | 业务员看不到库存/403 | 部署后立即执行 `seed-rbac`，并抽检业务员账号 |
| R-04 | P1 | 生产 admin 版本可能远落后（77c869b） | 后台缺少订单/样品/库存界面，跨越 3 个版本 | SSH 确认镜像 ID；按 §8.5 重建 admin 并做全量界面冒烟 |
| R-05 | P1 | 最近备份未核实 | 迁移失败时无可用恢复点 | 部署窗口第一步执行备份 + PGDMP 校验 + 临时库恢复演练 |
| R-06 | P2 | 443 未启用、无 HTTPS | 后台凭据与 JWT 明文传输（当前仅 IP 访问） | 后续单独阶段：域名 A 记录 + Let's Encrypt + 强制 HTTPS |
| R-07 | P2 | admin 3001 被安全组拦截 | 公网无法访问后台 | 保持现状或改用 `admin.bailingwooden.com` + 443；**本阶段未改安全组** |
| R-08 | P2 | 构建镜像占磁盘 | 服务器磁盘可能吃紧（历史曾 +9G） | 构建后 `docker builder prune`（需审批） |
| R-09 | P3 | 后台 favicon 缺失 | 控制台 404，无功能影响 | 后续补图标 |
| R-10 | P3 | 库存 PATCH 需全量字段 | 第三方集成不友好 | 后续可选拆 Partial DTO |

---

## 十一、保护措施确认（本阶段未改动）

| 对象 | 状态 | 本阶段动作 |
| --- | --- | --- |
| 旧网站 `bailingwooden.com` | Cloudflare 301，正常服务 | 未触碰 DNS/Cloudflare/源站 |
| DNS 解析 | 未变更 | 未执行任何 DNS 操作 |
| 企业邮箱 | 未变更 | 未触碰 SMTP/邮箱配置 |
| 防火墙 / 安全组 | **未变更** | 仅只读探测；用户自行决定是否临时放行 SSH |
| SSH 配置 | 未变更 | 未修改 sshd 配置 |
| 生产容器 | 未重启/未重建 | 仅公网 HTTP 探测 |

> 说明：UFW 22 端口白名单当前仅含 `60.210.239.23`。若后续需要常态化运维，建议评估固定出口 IP 或堡垒机方案，而不是每次临时放行。

---

## 十二、SSH 放行后必须补做的只读核查清单

放行后执行 `docs/phase-5.3.1-browser/prod-readonly-check.sh`（通过 stdin 执行，不落盘），重点核对：

| # | 项目 | 期望值/判断标准 |
| --- | --- | --- |
| 1 | 主机身份 | `hostname`、Ubuntu 24.04、metadata 公网 IP = 43.159.152.116 |
| 2 | 容器与镜像 | `bailing-frontend` / `bailing-backend` / `bailing-admin` / `bailing-postgres` 均 healthy；记录实际镜像 tag |
| 3 | 端口绑定 | 3000/4000/13001 仅绑 `127.0.0.1`；5432 不对外 |
| 4 | 后端版本 | 镜像 tag 与 `44497f7` 对应；`/opt/bailing/app/backend` 的 git HEAD |
| 5 | 迁移记录 | 15 条，最后一条为 `20261017170000_add_samples_and_orders`，**无** `20261018093000` |
| 6 | `orders` 表结构 | `code NOT NULL`，存在 `orders_code_key` 唯一索引 |
| 7 | 订单号数据质量 | 空值 0、重复 0；`min/max code` 记录样本 |
| 8 | `inventory_items` | `to_regclass` 为 NULL（表不存在） |
| 9 | 备份 | `/opt/bailing/backups/postgres` 最近文件时间 < 24h、大小 > 0、PGDMP 头 |
| 10 | 磁盘/内存 | 磁盘剩余 > 15%，可用内存 > 300MB |
| 11 | nginx | 80 default_server → 3000；`/api/v1`、`/uploads` → 4000；3001 vhost → 13001 |
| 12 | TLS | `/etc/letsencrypt/live` 不存在（预期无证书） |
| 13 | UFW | 22 仅白名单、80/443 放行、3001 放行 |
| 14 | 未发布变更 | 三仓库在服务器上的工作区是否干净 |

---

## 十三、下一阶段推荐动作

1. **放行 SSH**（已完成决策，待生效）→ 执行 §12 全部只读核查，回填本报告 §2/§4/§5 的「未核实」项。
2. **确认生产 admin 实际镜像**：若确为 `77c869b`，本次部署需按「跨 3 个版本」对待，验收范围扩大。
3. **备份 + 恢复演练**：在临时库完成一次恢复验证，记录耗时。
4. **安排部署窗口**：建议业务低峰（晚间），预留 30 分钟；窗口内后端与 admin 同步切换。
5. **部署后 24 小时观察**：5xx、库存 500、订单创建失败、备份是否正常。
6. **独立阶段处理 HTTPS 与后台域名**（不在本阶段）。

---

## 十四、附录：本次已执行的只读命令（节选）

```bash
# 公网探测
curl -s -o /dev/null -w "%{http_code}" http://43.159.152.116/
curl -s http://43.159.152.116/api/v1/health
curl -s http://43.159.152.116/api/v1/health/ready
for p in cms/orders cms/samples cms/inventory cms/roles; do
  curl -s -o /dev/null -w "$p %{http_code}\n" http://43.159.152.116/api/v1/$p
done

# 本地代码分析（只读）
git -C bailing-backend log --oneline -8
git -C bailing-backend diff --stat 44497f7 66ef13c
git -C bailing-admin diff --stat 77c869b 78af49a
cat bailing-backend/prisma/migrations/20261018093000_add_inventory_items/migration.sql
```

**未执行**：任何 `docker` 变更命令、任何 SQL 写入、任何服务重启、任何防火墙/DNS 变更。

---

**报告生成时间**：2026-10-19 09:05（GMT+8）
**报告状态**：`BLOCKED`（等待 SSH 放行后补做服务器侧只读核查）
