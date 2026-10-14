# DEVELOPMENT LOG — Phase 1

> 记录本阶段实际完成的工作、真实测试结果、未解决问题与后续计划。
> 所有结果均来自本机实际执行；未执行或阻塞的项如实标注，不伪造。

## 时间线

- 2026-10-13：Phase 1 执行（环境检查 → 后端/前端/数据库基础设施 → 测试 → 文档）。

## 1. 环境检查结果（Task 1 — 已执行且通过）

| 项目 | 实际结果 |
| --- | --- |
| 操作系统 | Windows（MINGW64_NT-10.0-19045，Git Bash） |
| Node.js | v22.22.2 ✅ |
| npm | 10.9.7 ✅ |
| Git | 2.55.0.windows.3 ✅ |
| Docker CLI | 29.8.0 ✅ |
| Docker Compose | v5.5.1 ✅ |
| 工作区 | 三个仓库（bailing-ui / bailing-admin / bailing-backend）均已初始化，均在 `261013` 分支，工作区干净，远端 `github.com/bailingsg/*` 已配置 |

## 2. 已完成工作

### 后端 bailing-backend（Task 3 — 代码完成，DB 相关步骤阻塞）

- NestJS 11 项目骨架：`src/main.ts`、`app.module.ts`、`app.setup.ts`（装配逻辑测试共用）。
- 全局管道 `ValidationPipe`（whitelist + forbidNonWhitelisted）、全局异常过滤器（统一错误结构、500 不回显堆栈）、全局响应拦截器（`{success, data}`）。
- 全局前缀 `/api/v1`；CORS 显式白名单（localhost:3000、127.0.0.1:3000），无 `*`。
- 配置集中管理 + 启动期环境变量校验（缺 `DATABASE_URL` 拒绝启动）。
- `GET /api/v1/health`、`GET /api/v1/health/ready`（就绪检查含数据库，未就绪 503）。
- PrismaService 采用**惰性连接**：数据库不在线时服务照常启动（原设计中 `onModuleInit` 强制连接会让 DB 抖动导致整个服务无法启动，与“health 不因 DB 不可用而失去响应”的规范冲突，故改惰性）。
- Prisma Schema：`AdminUser`、`Category`、`Product`、`Inquiry`、`BlogPost`、`MediaAsset` 六模型 + 索引 + slug 唯一约束 + 枚举；`MediaAsset.provider` 预留 `TENCENT_COS`。
- Docker Compose：postgres:17-alpine、命名卷持久化、`pg_isready` 健康检查、`unless-stopped`、端口仅绑 `127.0.0.1`。
- 测试：单元测试（HealthController 2 例）+ e2e（health/ready/404 三例）共 6 例。

### 前端 bailing-ui（Task 2 — 完成）

- Next.js 15.5.27 App Router + TS + Tailwind CSS v4 + shadcn/ui。
- `npx shadcn@latest add button badge` 实际执行成功（已验证可添加组件）。
- `src/app/layout.tsx`：Metadata API（title template、descriptionBase、robots 占位期 noindex）。
- `src/app/page.tsx`：服务端渲染首页，直连 `/api/v1/health/ready` 展示真实连接状态（3s 超时、不缓存、失败不崩页面）。
- 站点骨架：SiteHeader（导航）、SiteFooter、BackendStatusCard。
- 首页内容仅为 Phase 1 说明，无虚构产品/客户/企业数据。

### 基础设施与文档（Task 6/7/8 — 完成）

- 三个仓库 `.gitignore`；backend `.env` / `.env.example`；ui `.env` / `.env.example`。
- `docs/PHASE0-ARCHITECTURE.md`（含三仓库拓扑理由、选型与已否决方案）。
- `docs/PHASE1-SETUP.md`（零基础启动命令，均与实际脚本一致）。
- `docs/API-CONVENTIONS.md`（响应结构、状态码、校验、CORS、健康检查语义）。
- bailing-admin：占位 README + .gitignore（未启动开发，原因已说明）。
- PostgreSQL 相关：compose 就绪；**容器启动与迁移阻塞**（见第 4 节）。

## 3. 测试结果（Task 9 — 逐项如实标注）

### 已执行且通过 ✅

| 项 | 结果 |
| --- | --- |
| 后端依赖安装 | 694 packages，通过 |
| 后端 `tsc --noEmit` | 通过 |
| 后端 `eslint .` | 0 error / 0 warning |
| 后端 `jest` | 2 suites、6 tests 全部通过 |
| 后端 `nest build` | 通过（dist 产物正常） |
| Prisma `generate` | Client v6.19.3 生成成功 |
| Prisma schema 校验 | validate 随 generate 一并通过 |
| init 迁移 SQL 生成 | `prisma migrate diff --from-empty --to-schema-datamodel --script` 生成 166 行 DDL（6 表 / 5 枚举 / 12 索引），已存为 `prisma/migrations/20261013114209_init/migration.sql` |
| `docker compose config` | 通过（环境变量插值、端口绑定、健康检查均正确解析） |
| 前端依赖安装 | 338 packages，通过 |
| 前端 `tsc --noEmit` / `eslint .` | 通过 |
| 前端 `next build` | 通过（15.5.27；首页为动态渲染 ƒ） |
| 后端运行时 `curl /api/v1/health` | HTTP 200，`{"success":true,"data":{"status":"ok","uptime":...}}` |
| 后端运行时 `curl /api/v1/health/ready`（DB 未启动） | HTTP 503，`{"success":false,"error":{"code":503,"message":"Database is not ready"}}` |
| 后端未知路由 | HTTP 404，统一错误结构 |
| 后端日志 | 路由映射正常，无敏感信息泄露 |
| 前端 `next start` 首页 | HTTP 200；SSR HTML 含项目名、后端状态卡片、API 端点说明 |
| 前后端联调（DB 离线场景） | 首页展示“后端在线但未就绪”+ HTTP 503 + 数据库“未知”——错误路径展示正确 |

### 已执行但失败 → 已修复 ✅

| 项 | 原因 | 处置 |
| --- | --- | --- |
| `tsc` 初次报错 | TransformInterceptor 泛型与 `data ?? null` 不兼容 | `ApiSuccessResponse.data` 改为 `T \| null` |
| `eslint` 配置加载失败 | `@eslint/js` 为 CJS，命名导入失败 | 改默认导入；配置文件加 `projectService: false` 覆盖 |
| e2e 三例失败 | 测试 App 未应用全局过滤器/拦截器 | 抽出 `setupApp()`，main.ts 与 e2e 共用 |
| 前端首页显示“无法连接后端” | Node fetch 对 `localhost` 优先解析 IPv6 `::1`，后端只监听 IPv4 | 本地 API 地址改用 `127.0.0.1`（.env 与文档同步更新） |

### 因环境问题阻塞 ⛔

| 项 | 阻塞原因 | 解除方式 |
| --- | --- | --- |
| Docker 引擎启动 | Docker CLI/Desktop 已安装，但从当前 Agent 沙箱内启动 Docker Desktop 时，其后端进程写入 `~/.docker/daemon.json` 被拒（Access is denied）而崩溃；沙箱安全策略亦限制 GUI 程序启动 | **用户手动从开始菜单启动 Docker Desktop**，确认托盘显示 Engine running |
| `npm run db:up`（PostgreSQL 容器） | 上一项阻塞（CLI 正常，仅引擎未运行） | 引擎启动后直接执行 |
| `prisma migrate dev --name init` | 需要数据库在线 | init 迁移已用 diff 引擎离线生成入库；数据库启动后在仓库执行 `npm run prisma:deploy` 应用 |
| `/health/ready` 返回 200 的验证 | 需要数据库 | 迁移完成后执行 `curl` 验证 |
| 数据库持久化验证（容器重启后数据仍在） | 同上 | `db:down` → `db:up` 后查询表仍在 |
| 前端首页“已连接/正常”状态展示 | 依赖上一项 | 联调复验 |

## 4. 未解决问题 / 风险

1. **Docker Desktop 需手动启动**（见上）。用户启动后通知 Agent，即可完成剩余数据库验证并汇报。
2. 三个仓库本地已提交或待提交的推送（`git push`）需要 GitHub PAT——按仓库规范不在对话中传递令牌，用户自行 `git push` 或提供凭据后由 Agent 代推。

## 5. 后续计划（Phase 2 候选，不在本阶段执行）

- 产品分类页 / 产品详情页（slug URL + SEO metadata + sitemap）。
- 询盘提交 API（DTO 校验、限流、邮件通知接企业邮箱）。
- bailing-admin 启动：登录鉴权、产品/询盘/博客管理。
- 腾讯云 COS 上传抽象层（`MediaAsset.provider` 已预留）与 CDN。
- 数据库备份脚本（pg_dump）与生产 Docker Compose 部署。

## 6. Phase 1.1 追加记录（2026-10-13，Docker/PostgreSQL 验收第一次执行）

- 新增 `docs/PHASE1.1-ACCEPTANCE.md`。
- 已完成（静态/安全检查，全部一次通过）：三仓库分支与工作区检查（均在 261013，无未提交修改）；后端 package.json 脚本核对（db:up / db:down / prisma:deploy 与文档一致）；`docker compose config --quiet` 通过（命名卷 `bailing-postgres-data`、pg_isready 健康检查、127.0.0.1 端口绑定、env 注入无硬编码密钥、restart unless-stopped、仅 postgres 单服务）；`prisma validate` 通过；init 迁移（166 行 DDL：6 表 / 5 枚举 / 12 索引）与 migration_lock.toml 在库；`git check-ignore` + `git ls-files` + `git grep`（含全部提交历史）三重确认 .env 未跟踪、.env.example 与历史提交均不含真实密码。
- **阻塞（未执行，非失败）**：Docker Engine 未运行。沙箱内无法启动 Docker Desktop（后端进程写 `~/.docker/daemon.json` 被拒而崩溃；`wsl.exe` 被沙箱安全策略禁用）。解除方式：用户从开始菜单手动启动 Docker Desktop，待 `docker info` 可连接后通知 Agent。
- 剩余执行计划（引擎恢复后）：`npm run db:up` → `docker compose ps` 确认 healthy → `npm run prisma:deploy` → `npx prisma migrate status` → psql 核查六表与约束 → `start:dev` + `curl` 验证 /health 200 与 /ready 200 → 故障注入（`docker compose stop/start postgres`，不删卷）→ 持久化验证（临时验收表写入唯一标识 → 仅重启容器 → 复查 → 只删临时表）→ 前端首页联调 → 回填 PHASE1.1-ACCEPTANCE.md。
- 本轮未修改任何代码与配置，未删除数据卷，未重置数据库，未提交新代码。

## 7. Phase 1.1 最终验收（2026-10-13，引擎恢复后全部执行完成）

用户已手动启动 Docker Desktop，Engine 连接成功（Server: Docker Desktop 4.92.0 / Engine 29.8.0 / context desktop-linux）。以下全部实际执行并通过（详见 `docs/PHASE1.1-ACCEPTANCE.md`）：

- `npm run db:up` → 容器 `bailing-postgres` Up (healthy)，端口仅 127.0.0.1:5432，命名卷 `bailing-postgres-data` 已创建。
- `prisma validate` / `generate` / `prisma:deploy` 通过：init 迁移 applied；`migrate status` = up to date。
- psql 实测：6 业务表 + _prisma_migrations；slug/email 唯一约束、外键（RESTRICT/SET NULL）、索引齐全。
- `/api/v1/health` 200；`/api/v1/health/ready` DB 在线 200（`checks.database=true`）。
- 故障注入：`docker compose stop postgres` → /health 仍 200、/ready 503（未谎报）；`start postgres` 约 6s 恢复 healthy 后 /ready 恢复 200。
- 持久化：临时表 `phase1_1_acceptance_test` 写入唯一记录 → `docker restart` 容器（保留卷）→ 记录仍在 → DROP 临时表，业务表与迁移记录终态完好。
- 前端联调：`next dev` 首页 200，SSR 展示“后端服务就绪 / 已连接 / 数据库: 正常”。
- DB 在线复跑 Jest：6/6 通过（含 /ready 200 分支）。
- 处置记录：Next dev 首启被环境 safe-delete 组件拦截删除陈旧 `.next` 缓存而退出，清理 `.next` 后恢复（环境问题，非项目缺陷）。
- 安全复核：三仓库 .env 均未跟踪；历史与新增文档无真实密码；端口无公网暴露；未执行任何破坏性 Docker/Prisma 命令；未自动提交/推送（backend 两份文档变更待用户授权提交）。
- 容器现状：`bailing-postgres` 保持运行（本地开发库）；前后端测试进程已随任务结束清理。

## 8. Phase 4.1 记录（2026-10-14，管理员认证系统 + CMS 统计）

分支：`261014`（backend / admin 均从 dev 拉取）。开始前将 Phase 2–3.7 的未提交工作归档至 `261013` 并合入 dev。

### 已完成

- **数据库**：`AdminUser` / `AdminRole` 已随 init 迁移（`20261013114209_init`）建立，本阶段**无新增迁移**；`prisma migrate status` = up to date，`migrate diff` 漂移校验输出为空迁移（无漂移）。
- **Auth 模块** `src/modules/auth/`：`POST /api/v1/auth/login`（bcrypt 校验，失败统一 401 `Invalid email or password` + 占位哈希比较防时间侧信道）、`GET /api/v1/auth/me`（JWT 保护 + 数据库实时状态二次校验）、`JwtStrategy`（passport-jwt，Bearer 解析）、`JwtAuthGuard`（`guards/`）。
- **CMS 模块** `src/modules/cms/`：`GET /api/v1/cms/stats`（控制器级 `JwtAuthGuard`），Dashboard 统计全部为数据库真实计数（rfq total/byStatus、products、categories、blogPosts）。
- **密码**：bcryptjs cost 12，只存 `passwordHash`；`toAdminProfile` 显式挑选响应字段。
- **JWT**：`JWT_SECRET` / `JWT_EXPIRES_IN` 仅来自环境变量（`env.validation.ts` 强校验：生产缺失/短于 32 字符启动失败）；仅 access token（15m），不实现 refresh token（已在 API-CONVENTIONS 说明取舍）。
- **seed**：`prisma/seed.ts` 新增 `seedDefaultAdmin`（读 `ADMIN_EMAIL`/`ADMIN_PASSWORD`，幂等 + 口令轮换同步）；显式 `import 'dotenv/config'`（此前依赖环境隐式加载 .env，不可靠）。
- **兼容性**：RFQ 后台接口保持 `AdminTokenGuard`（X-Admin-Token）不变，e2e 验证公开提交 201 与后台列表行为不变。
- **测试**：`test/auth.spec.ts`（单元 8 例：登录成功/大小写/口令错误/邮箱不存在/停用、me 有效/停用/删除）+ `test/auth.e2e-spec.ts`（login 成功/两类失败/DTO 400、JWT 无令牌与伪造令牌 401、me、cms/stats 401+真实计数、RFQ 兼容 2 例）；全套 35 例通过。
- lint / typecheck / build 通过；修复 `test/rfq.spec.ts` 遗留的未使用变量 lint 错误。
- **Admin**（bailing-admin）：`/login`（客户端表单 → 同源路由 `POST /api/auth/login` 转发后端并写 HttpOnly Cookie，失败显示 `Invalid email or password`）、`(dashboard)` 路由组（Sidebar + Header + 内容；layout 以 JWT 调 `/auth/me` 做服务端鉴权）、`/dashboard` 统计卡片（真实数据，来源 `/cms/stats`）、middleware 保护 `/dashboard/**` 与 `/rfq/**`、根路径重定向 `/dashboard`、登出路由。
- **运行时验证**（生产模式双服务 + `docs/phase-4.1-verify.mjs`）：17/17 通过（登录页 200、未登录 307 跳转带 next、错误/不存在邮箱 401 同文案、正确凭证 200 + HttpOnly Cookie、登录后 dashboard/rfq 200 且含真实统计、伪造 Cookie 拒绝、登出后回登录页）。

### 问题与处置

- `@nestjs/jwt@12` / `@nestjs/passport@12` 为 ESM-only，与本项目 CommonJS 构建冲突（ts-jest 报 `Cannot use import statement outside a module`）→ 降级 `@nestjs/jwt@11.0.2` + `@nestjs/passport@11.0.5`（后者 peer 未含 Nest 11，用 `--legacy-peer-deps` 安装）。
- `passport-jwt@^4.7` / `bcryptjs@^2.4.31` 版本不存在导致 ETARGET → 改用 `^4.0.1` / `^3.0.3`。
- seed 首次运行产出的管理员口令与环境不一致：诊断确认为写入 `.env` 时强随机口令被工具链脱敏为 `<SECRET_*>` 占位符落盘。处置：改为运行时生成口令直接写 `.env` 并同步库中哈希；seed 增加显式 dotenv 加载。
- 暂时阻塞：`github.com` 经本地代理持续 502，git push 未成功（提交已在本地分支，网络恢复后补推）。

### 未做（按阶段禁令）

产品 CMS / Blog CMS / 文件上传 / 富文本编辑器 / 用户管理 / 权限系统（RBAC）/ 邮件通知——均未开发。
