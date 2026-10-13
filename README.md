# bailing-backend — Bailing Wooden B2B 后端 API

百灵木业 B2B 独立站的后端服务：NestJS REST API + Prisma ORM + PostgreSQL（本地 Docker）。

配套仓库：主站 [`bailing-ui`](../bailing-ui) · 管理后台 [`bailing-admin`](../bailing-admin)（Phase 2 启动）。

## 技术栈

- NestJS 11（REST API、全局校验、统一异常处理、统一响应结构）
- TypeScript（strict 模式）
- Prisma 6 + PostgreSQL 17（本地 Docker Compose，数据卷持久化）
- Jest（单元测试 + e2e 冒烟测试）

## 目录结构

```
bailing-backend/
├── src/
│   ├── main.ts                  # 入口：启动 + 装配
│   ├── app.module.ts            # 根模块
│   ├── app.setup.ts             # 全局管道/过滤器/拦截器/CORS（测试共用）
│   ├── config/                  # 配置集中定义 + 启动期环境变量校验
│   ├── common/                  # 统一响应类型、异常过滤器、响应拦截器
│   └── modules/
│       ├── health/              # GET /api/v1/health、/api/v1/health/ready
│       └── prisma/              # Prisma 服务（惰性连接）
├── prisma/
│   ├── schema.prisma            # 数据模型（6 个基础模型）
│   └── migrations/              # Prisma 迁移（唯一允许的数据库变更方式）
├── infrastructure/
│   └── docker/docker-compose.yml  # 本地 PostgreSQL
├── test/                        # 单元 + e2e 测试
└── docs/                        # 架构、安装、API 规范、开发日志
```

## 快速开始（本地开发）

前置：Node.js ≥ 20、Docker Desktop（已启动）。

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env   # 自行修改本地密码（.env 已被 .gitignore，不会提交）

# 3. 启动数据库（PostgreSQL 容器，仅绑定 127.0.0.1）
npm run db:up

# 4. 执行首个迁移并生成 Prisma Client
npm run prisma:migrate

# 5. 启动后端（热更新）
npm run start:dev
```

API 基地址：`http://localhost:4000/api/v1`（或 `http://127.0.0.1:4000/api/v1`）。

健康检查：

```bash
curl http://127.0.0.1:4000/api/v1/health
curl http://127.0.0.1:4000/api/v1/health/ready
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run start:dev` | 开发模式（watch） |
| `npm run build` | 生产构建 |
| `npm run start:prod` | 运行构建产物 |
| `npm run lint` / `npm run typecheck` | ESLint / tsc |
| `npm test` | Jest（单测 + e2e） |
| `npm run db:up` / `npm run db:down` | 启动 / 停止数据库容器 |
| `npm run db:reset` | 重置数据库（危险：清空数据） |
| `npm run prisma:deploy` | 应用已有迁移（CI/生产用，不生成新迁移） |

## 环境变量

见 [.env.example](./.env.example)。要点：

- `DATABASE_URL` 为必填；数据库密码只存在于本地 `.env`，禁止入库 / 提交 Git。
- `PORT`、`HOST`、`CORS_ORIGINS` 均可配置；**CORS 禁止使用 `*`**，必须显式列出前端 Origin。
- 前端 `NEXT_PUBLIC_API_BASE_URL` 指到本服务即可。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| `/api/v1/health/ready` 返回 503 | Docker Desktop 未启动或 `npm run db:up` 未执行；`docker ps` 确认 `bailing-postgres` 健康 |
| 启动报“缺少必填环境变量” | 未创建 `.env` 或 `DATABASE_URL` 为空 |
| Prisma 报连接失败 | 检查 `.env` 中密码与 docker-compose 的 `POSTGRES_PASSWORD` 一致 |
| 端口 5432 被占用 | 修改 `.env` 的 `POSTGRES_PORT` 后重新 `npm run db:up` |
| 迁移失败（P3005 等） | 数据库非空导致，开发库可 `npm run db:reset` 重建 |

更多文档：[docs/PHASE0-ARCHITECTURE.md](./docs/PHASE0-ARCHITECTURE.md) ·
[docs/PHASE1-SETUP.md](./docs/PHASE1-SETUP.md) ·
[docs/API-CONVENTIONS.md](./docs/API-CONVENTIONS.md) ·
[docs/DEVELOPMENT-LOG.md](./docs/DEVELOPMENT-LOG.md)
