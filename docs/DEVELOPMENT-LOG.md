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
