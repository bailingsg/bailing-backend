# PHASE 1.1 — Docker 与 PostgreSQL 数据库验收记录（最终）

> 验收日期：2026-10-13（最终执行：宿主机 Docker Desktop 已由用户手动启动，全部验收项实际执行完成）
> 验收人：Agent（DevOps 角色）；复核：项目负责人

## 1. 环境状态（实际检测）

| 项目 | 版本 / 状态 |
| --- | --- |
| 操作系统 | Windows（MINGW64_NT-10.0-19045，Git Bash） |
| Docker Client | 29.8.0（windows/amd64），context: `desktop-linux` |
| **Docker Server** | **Docker Desktop 4.92.0 / Engine 29.8.0，连接成功**（`docker info` 返回 ServerVersion=29.8.0，Containers=4） |
| Docker Compose | v5.5.1 |
| PostgreSQL | 17.11（容器内 `postgres:17-alpine`），`Up (healthy)` |
| Prisma | Client v6.19.3；1 migration applied（20261013114209_init）；schema up to date |
| NestJS 后端 | `start:dev` 运行于 127.0.0.1:4000 |
| Next.js 前端 | `next dev` 运行于 127.0.0.1:3000 |

## 2. Docker Engine 连接

- `docker version` 同时返回 Client 与 Server 段（Docker Desktop 4.92.0 / Engine 29.8.0 / linux-amd64）✅
- `docker info` 成功读取服务端信息 ✅
- 前置说明：此前 Agent 沙箱内无法启动 Docker Desktop（后端进程写 `~/.docker/daemon.json` 被拒崩溃、`wsl.exe` 被沙箱策略禁用），已如实报告并由用户手动启动解决。

## 3. Docker Compose 配置与容器检查（通过）

路径：`bailing-backend/infrastructure/docker/docker-compose.yml`（服务名 `postgres`，容器名 `bailing-postgres`）

- ✅ `docker compose config` 通过（Phase 1.1 首轮 + 本轮各一次）
- ✅ `npm run db:up` 启动成功：Container Started，Volume `bailing-postgres-data` Created
- ✅ 容器最终 `Up (healthy)`，`pg_isready` 健康检查通过；日志无初始化失败
- ✅ 端口仅绑定 `127.0.0.1:5432`（`docker port` 实测：`5432/tcp -> 127.0.0.1:5432`），无公网暴露
- ✅ 使用命名卷 `bailing-postgres-data`；`restart: unless-stopped`；仅 postgres 单服务
- ✅ 容器启动前已确认本机既有容器（n8n/ollama/open-webui 等）与本项目无冲突，未做任何干预

## 4. Prisma 与迁移（通过）

| 命令 | 结果 |
| --- | --- |
| `npx prisma validate` | schema valid ✅ |
| `npx prisma generate` | Client v6.19.3 生成 ✅ |
| `npm run prisma:deploy` | **1 migration found，Applying `20261013114209_init`，All migrations successfully applied** ✅ |
| `npx prisma migrate status` | **Database schema is up to date!** ✅ |

## 5. 数据库结构核查（通过，psql 实测）

表清单（public schema）：`admin_users`、`categories`、`products`、`inquiries`、`blog_posts`、`media_assets` + `_prisma_migrations`（迁移记录 1 条，`applied=t`）。

- ✅ 六模型与表映射与 schema `@@map` 一致（模型名 → 实际表名不同属预期：`AdminUser → admin_users` 等）
- ✅ 主键：六表均 `_pkey PRIMARY KEY (id)`
- ✅ slug 唯一约束（唯一索引实测）：`products_slug_key`、`categories_slug_key`、`blog_posts_slug_key`；另有 `admin_users_email_key`
- ✅ 外键实测：`products_categoryId_fkey → categories(id) ON DELETE RESTRICT`；`inquiries_productId_fkey → products(id) ON DELETE SET NULL`；`categories_parentId_fkey` 自关联；`blog_posts_authorId_fkey → admin_users`
- ✅ 二级索引实测：products(status/categoryId)、categories(parentId)、inquiries(status/createdAt)、blog_posts(status/publishedAt)、media_assets(provider)
- ✅ 时间字段：`createdAt`（默认 CURRENT_TIMESTAMP）与 `updatedAt` 存在于全模型

## 6. 后端健康检查（通过，curl 实测）

后端 `npm run start:dev`，请求 `http://127.0.0.1:4000`：

| 接口 | DB 在线 | DB 离线（故障注入） | DB 恢复后 |
| --- | --- | --- | --- |
| `GET /api/v1/health` | **200** `{"success":true,"data":{"status":"ok","uptime":6,...}}` | **200**（存活保持） | 200 |
| `GET /api/v1/health/ready` | **200** `{"success":true,"data":{"status":"ready","checks":{"database":true}}}` | **503** `{"success":false,"error":{"code":503,"message":"Database is not ready"}}` | **200** `checks.database=true` |

- ✅ 响应符合统一 API 契约（`{success,data}` / `{success,error}`）；无堆栈、无密码、无连接串泄露
- ✅ liveness 与 readiness 语义分离，符合设计

## 7. 故障恢复验证（通过）

1. 前置状态：`running / healthy`。
2. `docker compose stop postgres`（仅停止，未删容器/卷）→ 容器 `exited`。
3. `/api/v1/health` 仍 **200**；`/api/v1/health/ready` **503**（未谎报就绪）；后端进程未崩溃。
4. `docker compose start postgres` → 约 6s 后 `healthy`。
5. 两接口恢复：`/health` 200，`/ready` 200（`database:true`）。

## 8. 数据持久化验证（通过）

1. 创建专用临时表 `phase1_1_acceptance_test`（明确命名，与业务表隔离）。
2. 写入唯一记录 `id='phase1_1_acceptance_20261013_1159', marker='persistence_check'`，查询确认存在。
3. `docker restart bailing-postgres`（仅重启容器，命名卷保留）→ 恢复 healthy。
4. 复查：记录仍在（同 id / marker / created_at 04:05:37.404）✅ 持久化成立。
5. 清理：`DROP TABLE phase1_1_acceptance_test`（仅删该临时表）。
6. 终态复核：public schema 剩 7 表（6 业务表 + _prisma_migrations），迁移记录完好，`migrate status` = up to date。无任何业务数据被触碰。

## 9. 前端联调（通过）

- 启动：`bailing-ui` 下 `npm run dev`（NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000/api/v1，实际读取 .env 确认）。
- `GET http://127.0.0.1:3000/` → **HTTP 200**；SSR HTML 实测包含：“后端服务就绪”、“已连接”、“数据库: 正常”。
- 页面为服务端渲染直连只读健康检查接口，前端无任何数据库访问；未改版 UI、未新增业务模块。
- 备注：dev 首启曾因本环境文件安全组件拦截 Next 删除陈旧 `.next` 缓存而退出；清理 `.next` 构建缓存后恢复，非项目代码问题。

## 10. 测试套件复跑（DB 在线，通过）

`npx jest`：2 suites / 6 tests 全部通过（覆盖 /health 200、/ready 200（DB 在线分支）、/ready 503、404 结构）。

## 11. Git 与安全检查（通过）

- ✅ 三仓库当前分支 `261013`；`bailing-ui`/`bailing-admin` 工作区干净；`bailing-backend` 仅两份验收文档变更（**按本轮规范未自动提交/推送**）。
- ✅ 三仓库 `.env` 均被 `.gitignore` 忽略（`git check-ignore` 逐一验证）。
- ✅ `git grep` 全部提交历史 + 新增文档：无真实数据库密码 / 连接串凭据。
- ✅ PostgreSQL 端口未做任何公网暴露改动。
- ✅ 原有迁移文件未被重写；未执行 `down -v` / `volume prune` / `system prune` / `migrate reset` / `db push`。
- ✅ 未要求用户提供 GitHub PAT；未执行远程推送。

## 12. 失败项与修复过程

- Next.js dev 启动退出：环境安全组件（safe-delete shim）拦截删除陈旧 `.next` 缓存 → 清理 `.next` 后恢复（环境问题，非项目缺陷）。

## 13. 结论

**Phase 1 数据库验收闭环：全部必需项实际执行并通过。** 数据库可启动、迁移成功、结构符合 schema、在线/离线健康检查语义正确、故障可恢复、数据持久化实证成立、前端状态展示正确、安全检查通过。
