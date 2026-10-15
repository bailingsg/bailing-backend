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

## 当前状态（Phase 4.5）

- Phase 3.1：工程底座已验收（tsc / ESLint / Jest / 构建 / 健康检查）。
- Phase 3.5：`Product` 模型扩展 + `ProductImage`，迁移 `20261013161709_add_product_details` 已应用；产品与分类只读 API 已上线。
- Phase 3.7：RFQ 询盘系统（公开提交 + 后台三接口 `X-Admin-Token` 保护）。
- Phase 4.1：管理员认证系统已上线——
  - `admin_users` 表随 init 迁移建立（无新增迁移、无漂移）；
  - `POST /api/v1/auth/login` + `GET /api/v1/auth/me`（JWT，`JwtAuthGuard`）；
  - `GET /api/v1/cms/stats`（JWT 保护，Dashboard 真实统计）；
  - 口令 bcrypt(cost 12) 哈希，seed 从 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 初始化默认管理员。
- Phase 4.2：Products CMS 已上线——
  - `GET/POST /api/v1/cms/product-categories`、`PATCH/DELETE /:id`（slug 冲突 409；分类下有产品禁删 400）；
  - `GET/POST /api/v1/cms/products`、`GET/PATCH/DELETE /:id`（分页 + keyword/status/categoryId 筛选；创建默认 DRAFT）；
  - `POST /api/v1/cms/products/:id/images`（multipart 上传：类型/大小白名单 + 魔数校验 + UUID 文件名）、`DELETE /:id/images/:imageId`（删文件 + 主图自动提升）；
  - 本地存储 `uploads/products/`（`.gitignore` 排除），静态前缀 `/uploads/products`；迁移 `20261014120152_add_product_applications`（JSONB）。
  - `lint` / `typecheck` / `test`（82 项）/ `build` / `migrate status` / drift 校验全部通过。
- Phase 4.3：Media Library 媒体资源库已上线——
  - **Storage Adapter 模式**：`StorageProvider` 接口 + `LocalStorageProvider` 实现 + `TencentCosStorageProvider` 预留占位，`STORAGE_PROVIDER` 环境变量切换，业务代码零侵入；
  - `POST /api/v1/cms/media/upload`（multipart，内存接收；MIME + **魔数** + 10MB 校验；UUID 存储键 `media/<年>/<月>/<uuid>.<ext>`）、`GET /api/v1/cms/media`（分页 + keyword/category）、`GET /:id`、`DELETE /:id`（**引用检查**：被 `ProductImage` 引用 → 400 `Media asset is in use.`），全部 `JwtAuthGuard`；
  - 迁移 `20261014151500_add_media_assets`（演扩 Phase 1 预留模型，零漂移）；静态前缀 `/uploads/media`；
  - `lint` / `typecheck` / `test`（**113 项**）/ `build` / drift 校验全部通过；浏览器全流程验证通过（`docs/phase-4.3-browser-flow.sh`）。
- Phase 4.4：Blog CMS + SEO 内容管理系统已上线——
  - **数据结构**：演扩 Phase 1 预留 `BlogPost`（新增 `coverMediaId` / `categoryId` / `featured` / SEO 四字段 / OG 三字段 / Twitter 两字段，保留 `coverImageUrl` 作 URL 快照），新增 `BlogCategory` / `BlogTag` / `BlogPostTag`；迁移 `20261014171544_add_blog_cms`（零漂移）；
  - **接口**（`/api/v1/cms/blog`，全部 `JwtAuthGuard`）：`posts` CRUD（分页 + keyword/status/categoryId/tagId/featured 筛选，发布时自动回填 `publishedAt`）、`categories` CRUD（含 postCount，分类下有文章禁删 400）、`tags` CRUD（显式 join 模型，级联解绑）；
  - **富文本安全**：自研白名单净化器 `rich-text.sanitizer.ts`（标签 / 属性 / URL 协议三层白名单 + 实体解码 + 控制字符过滤，**零第三方依赖**）；
  - **媒体引用保护扩展**：被 `ProductImage` **或** `BlogPost` 封面引用的媒体，`DELETE /cms/media/:id` 返回 400 `Media asset is in use.`；
  - **SEO**：`seoTitle` / `seoDescription` / `seoKeywords` / `canonicalUrl` + OG / Twitter Card 预留字段（本阶段仅存储与透出）；
  - `lint` / `typecheck` / `test`（**176 项**）/ `build` / `migrate status` / drift 校验全部通过；浏览器全流程验证 **38/38 PASS**（`docs/phase-4.4-browser-flow.mjs`）。
- Phase 4.5：Factory / Quality / Applications 企业内容 CMS 已上线——
  - **数据模型**（纯新增，迁移 `20261015112244_add_enterprise_cms`，零漂移）：枚举 `ContentStatus` / `FactorySectionType` / `QualityRecordType`；表 `factory_sections` / `factory_images` / `factory_exhibitions` / `quality_records` / `applications` / `application_products`；
  - **Factory（工厂实力）**（`/api/v1/cms/factory`，`JwtAuthGuard`）：分区 CRUD + 图库（ALT / 排序 / 解除关联）+ **结构化展会模型**（非单一 JSON）+ 封面；六种 `sectionType`；
  - **Quality（质量体系）**（`/api/v1/cms/quality`，`JwtAuthGuard`）：记录 CRUD；`issuer / certificateNumber / issueDate / expiryDate` **全部可空**（不编造任何认证信息，缺失不推断过期）；支持 PDF 证书；
  - **Applications（产品应用场景）**（`/api/v1/cms/applications`，`JwtAuthGuard`）：场景 CRUD + **显式多对多 `ApplicationProduct` 关联产品**（基于 `productId`，非名称匹配）；删除场景**不删除产品**（产品侧 `Restrict`）；
  - **公开只读接口**（`/api/v1/public/{factory,quality,applications}`，**免鉴权**）：仅返回 `PUBLISHED` 内容；非发布 slug 返回 404（不泄露存在性）；DTO 白名单映射，**不透出** `storageKey / createdBy / provider / status / sortOrder`；
  - **媒体库扩展**：新增 `DOCUMENT` 类别与 PDF 支持；`countReferences` 扩展至三模块，被引用媒体删除返回 400 `Media asset is in use.`；
  - `lint` / `typecheck` / `test`（**238 项**）/ `build` / `migrate status` / drift 校验全部通过；浏览器全流程验证 **34/34 PASS**（`docs/phase-4.5-admin-e2e.mjs`）。

## 环境变量

见 [.env.example](./.env.example)。要点：

- `DATABASE_URL` 为必填；数据库密码只存在于本地 `.env`，禁止入库 / 提交 Git。
- `PORT`、`HOST`、`CORS_ORIGINS` 均可配置；**CORS 禁止使用 `*`**，必须显式列出前端 Origin（当前含 3000 主站与 3001 后台）。
- 前端 `NEXT_PUBLIC_API_BASE_URL` 指到本服务即可。
- **认证（Phase 4.1）**：`JWT_SECRET`（必填强随机，生产缺失/过短启动失败）、`JWT_EXPIRES_IN`（默认 `15m`，仅 access token）、`ADMIN_EMAIL` / `ADMIN_PASSWORD`（seed 默认管理员，禁止硬编码口令）。
- **图片上传（Phase 4.2）**：`UPLOADS_BASE_URL`（入库图片 URL 基地址，默认后端自身；生产可指向 CDN）、`UPLOAD_MAX_FILE_SIZE`（字节，默认 5MB）。
- **媒体库（Phase 4.3）**：`STORAGE_PROVIDER`（`LOCAL` 默认 / `TENCENT_COS` 预留）、`MEDIA_MAX_FILE_SIZE`（字节，默认 10MB）、`MEDIA_UPLOAD_DIR`（媒体根目录，默认 `<backend>/uploads/media`）。

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
