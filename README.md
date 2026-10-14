# bailing-backend — Bailing Wooden B2B 后端 API

百灵木业 B2B 独立站的后端服务：NestJS REST API + Prisma ORM + PostgreSQL（本地 Docker）。

配套仓库：主站 [`bailing-ui`](../bailing-ui) · 管理后台 [`bailing-admin`](../bailing-admin)。

三仓库本地联调规范（端口、环境变量、启动顺序、排查）见共享工作区文档：[`docs/LOCAL-DEV-SETUP.md`](../docs/LOCAL-DEV-SETUP.md)。

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
│       ├── products/            # GET /api/v1/products、/api/v1/products/:slug
│       ├── categories/          # GET /api/v1/categories
│       └── prisma/              # Prisma 服务（惰性连接）
├── prisma/
│   ├── schema.prisma            # 数据模型
│   ├── seed.ts                  # Demo/Placeholder 数据种子（可选执行）
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
| `npm run prisma:deploy` | 应用已有迁移（CI/生产用，不生成新迁移） |
| `npm run prisma:migrate` | 开发期生成并应用新迁移（会生成迁移文件，不重置数据） |
| `npm run prisma:seed` | 初始化默认管理员（读 `ADMIN_EMAIL`/`ADMIN_PASSWORD`）+ 写入 Demo/Placeholder 产品与分类（幂等，可重复执行） |

## 产品 API（Phase 3.5）

公开只读接口，仅返回 `status = PUBLISHED` 的产品（草稿/归档不会泄漏）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/products` | 产品列表，支持 `page`、`pageSize`（≤48）、`category`（分类 slug）、`featured`（`true`/`false`） |
| `GET /api/v1/products/:slug` | 产品详情；不存在或未发布返回 404 |
| `GET /api/v1/categories` | 分类列表（含各分类已发布产品数 `productCount`），供筛选器使用 |

响应统一经 `TransformInterceptor` 包装为 `{ success: true, data }`：

```jsonc
// GET /api/v1/products
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "…", "slug": "…", "name": "…",
        "shortDescription": "…",
        "category": { "id": "…", "slug": "…", "name": "…" },
        "material": null, "application": null, "featured": false,
        "images": [{ "id": "…", "url": "…", "altText": null, "sortOrder": 0, "isPrimary": true }]
      }
    ],
    "total": 3, "page": 1, "pageSize": 12, "totalPages": 1
  }
}
```

详情在列表项基础上追加 `description`、`specifications`、`seo`、`createdAt`、`updatedAt`。

> **产品数据为 Demo/Placeholder**：`prisma/seed.ts` 写入的记录名称以 `Demo ·` 开头、描述标注 `[DEMO DATA]`，**不含**任何编造的规格、认证、价格或图片。CMS 阶段可直接删除。
> 本产品线为 B2B 制造与出口，**不含** price / stock / sku / cart / payment / rating / review 等电商字段。

## 当前状态（Phase 4.1）

- Phase 3.1：工程底座已验收（tsc / ESLint / Jest / 构建 / 健康检查）。
- Phase 3.5：`Product` 模型扩展 + `ProductImage`，迁移 `20261013161709_add_product_details` 已应用；产品与分类只读 API 已上线。
- Phase 3.7：RFQ 询盘系统（公开提交 + 后台三接口 `X-Admin-Token` 保护）。
- Phase 4.1：管理员认证系统已上线——
  - `admin_users` 表随 init 迁移建立（无新增迁移、无漂移）；
  - `POST /api/v1/auth/login` + `GET /api/v1/auth/me`（JWT，`JwtAuthGuard`）；
  - `GET /api/v1/cms/stats`（JWT 保护，Dashboard 真实统计）；
  - 口令 bcrypt(cost 12) 哈希，seed 从 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 初始化默认管理员；
  - `lint` / `typecheck` / `test`（35 项）/ `build` / `migrate status` / drift 校验全部通过。

## 环境变量

见 [.env.example](./.env.example)。要点：

- `DATABASE_URL` 为必填；数据库密码只存在于本地 `.env`，禁止入库 / 提交 Git。
- `PORT`、`HOST`、`CORS_ORIGINS` 均可配置；**CORS 禁止使用 `*`**，必须显式列出前端 Origin（当前含 3000 主站与 3001 后台）。
- 前端 `NEXT_PUBLIC_API_BASE_URL` 指到本服务即可。
- **认证（Phase 4.1）**：`JWT_SECRET`（必填强随机，生产缺失/过短启动失败）、`JWT_EXPIRES_IN`（默认 `15m`，仅 access token）、`ADMIN_EMAIL` / `ADMIN_PASSWORD`（seed 默认管理员，禁止硬编码口令）。

## 初始化默认管理员（Phase 4.1）

```bash
# .env 中配置 ADMIN_EMAIL / ADMIN_PASSWORD 后执行（幂等；口令变更会自动同步）
npm run prisma:seed
```

登录：`POST /api/v1/auth/login` → `{ "email", "password" }` →
返回 `accessToken`；随后以 `Authorization: Bearer <accessToken>` 访问
`/auth/me` 与 `/cms/stats`。失败统一返回 `401 Invalid email or password`。

## 数据库安全红线（持续有效）

命名卷 `bailing-postgres-data` 保存全部数据。禁止以下操作：`docker compose down -v`、`docker volume prune`、`prisma migrate reset`、`prisma db push`、删除或重写迁移文件、重建数据库、将端口暴露公网。结构变更只能通过新增迁移进行。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| `/api/v1/health/ready` 返回 503 | Docker Desktop 未启动或 `npm run db:up` 未执行；`docker ps` 确认 `bailing-postgres` 健康 |
| 启动报“缺少必填环境变量” | 未创建 `.env` 或 `DATABASE_URL` 为空 |
| Prisma 报连接失败 | 检查 `.env` 中密码与 docker-compose 的 `POSTGRES_PASSWORD` 一致 |
| 端口 5432 被占用 | 修改 `.env` 的 `POSTGRES_PORT` 后重新 `npm run db:up`（勿停他人容器） |
| 迁移失败（P3005 等） | **不要**直接 `db:reset`；先对照 `docs/LOCAL-DEV-SETUP.md` 的安全红线确认原因，必要时人工评估迁移方案 |

更多文档：[docs/PHASE0-ARCHITECTURE.md](./docs/PHASE0-ARCHITECTURE.md) ·
[docs/PHASE1-SETUP.md](./docs/PHASE1-SETUP.md) ·
[docs/API-CONVENTIONS.md](./docs/API-CONVENTIONS.md) ·
[docs/DEVELOPMENT-LOG.md](./docs/DEVELOPMENT-LOG.md)
