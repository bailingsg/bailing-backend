# PHASE 1 — 本地环境配置与启动指南

> 从零开始：安装依赖 → 启动数据库 → 迁移 → 启动前后端。
> 所有命令均在本机验证过（见 DEVELOPMENT-LOG.md 的测试结果记录）。

## 0. 前置条件

| 工具 | 版本要求 | 检查命令 |
| --- | --- | --- |
| Node.js | ≥ 20（LTS） | `node -v` |
| npm | ≥ 10 | `npm -v` |
| Docker Desktop | 已安装且**已启动** | `docker info` |
| Git | ≥ 2.x | `git --version` |

> **重要**：执行任何 Docker 命令前，先在开始菜单启动 Docker Desktop，等到托盘图标显示 "Engine running"（`docker info` 能返回版本号）再进行下一步。

## 1. 克隆仓库（已克隆可跳过）

```bash
git clone https://github.com/bailingsg/bailing-backend.git
git clone https://github.com/bailingsg/bailing-ui.git
git clone https://github.com/bailingsg/bailing-admin.git
```

三个仓库各自独立开发，无 monorepo 根目录。

## 2. 启动数据库（bailing-backend）

```bash
cd bailing-backend
npm install
cp .env.example .env        # 然后编辑 .env，设置本地强密码
npm run db:up               # docker compose 启动 PostgreSQL（仅绑定 127.0.0.1:5432）
docker ps                   # 确认 bailing-postgres 健康 (healthy)
```

数据持久化在命名卷 `bailing-postgres-data`；`npm run db:down` 停止容器但**保留数据**。

## 3. 数据库迁移（bailing-backend）

仓库已包含首个迁移 `prisma/migrations/20261013114209_init/`（schema 全量 DDL，由 Prisma `migrate diff` 引擎生成，与 `migrate dev` 产物同源）。

```bash
npm run prisma:deploy      # 应用已有迁移（推荐：与 CI/生产一致，不生成新迁移）
```

开发期新建迁移（改了 schema 后）仍使用：

```bash
npm run prisma:migrate     # = prisma migrate dev，生成并应用新迁移
```

## 4. 启动后端（bailing-backend）

```bash
npm run start:dev           # 开发模式 watch，默认 http://127.0.0.1:4000/api/v1
```

验证：

```bash
curl http://127.0.0.1:4000/api/v1/health      # 200 {"success":true,"data":{"status":"ok",...}}
curl http://127.0.0.1:4000/api/v1/health/ready # 200（数据库在线时）
```

## 5. 启动前端（bailing-ui）

```bash
cd ../bailing-ui
npm install
cp .env.example .env        # 默认 NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000/api/v1
npm run dev                 # http://localhost:3000
```

首页会在服务端请求 `/api/v1/health/ready`，展示后端与数据库真实状态。

## 6. 停止服务

```bash
# 前端 / 后端：在各自终端 Ctrl+C
# 数据库：
cd bailing-backend && npm run db:down
```

## 7. 重置数据库（危险操作）

```bash
cd bailing-backend
npm run db:reset            # 会删除所有表与数据并重放迁移，仅限开发库！
```

## 8. 生产构建验证

```bash
# bailing-backend
npm run build && npm run start:prod

# bailing-ui
npm run build && npm run start
```

## 9. 常见故障

| 现象 | 原因与解决 |
| --- | --- |
| `docker compose up` 连接失败 | Docker Desktop 未启动；见第 0 节 |
| `/health/ready` 返回 503 | 数据库容器未启动或密码不一致；`docker ps` + `.env` 核对 |
| 启动报“缺少必填环境变量” | 未创建 `.env` 或 `DATABASE_URL` 为空 |
| 前端首页显示“无法连接后端服务” | 后端未启动，或 `NEXT_PUBLIC_API_BASE_URL` 指向错误（本地推荐 `127.0.0.1`，避免 Node fetch 优先走 IPv6 `::1` 时连不上只监听 IPv4 的服务） |
| 5432 端口被占用 | 修改 `.env` 的 `POSTGRES_PORT`，同步改 `DATABASE_URL`，然后 `npm run db:up` |
