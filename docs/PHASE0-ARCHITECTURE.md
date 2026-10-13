# PHASE 0 — 架构决策记录（ADR 摘要）

> 项目：Bailing Wooden B2B Website（bailingwooden.com）
> 本文档记录整体架构、技术选型与部署原则，是后续阶段决策的基线。

## 1. 业务定位

面向海外采购商的木制品 B2B 外贸独立站：

- 展示产品、产品分类、工厂实力与企业信息；
- 获取海外客户询盘（Inquiry）；
- 支持 Google SEO（SSR/SSG、slug URL、Metadata API）；
- 响应式（手机 / 平板 / 桌面）；
- 后续扩展：英文目录、内容管理后台、多语言、询盘管理。

## 2. 仓库拓扑（三仓库分离）

项目由三个独立 Git 仓库组成（github.com/bailingsg 下，均为私有）：

| 仓库 | 职责 | 技术栈 |
| --- | --- | --- |
| `bailing-ui` | 主站（前台） | Next.js 15 + shadcn/ui |
| `bailing-admin` | 管理后台（Phase 2 启动，当前占位） | Phase 2 定（倾向 Next.js 同构） |
| `bailing-backend` | 后端 API + 数据库基础设施 + 项目文档 | NestJS 11 + Prisma 6 + PostgreSQL 17 |

**为什么不用 monorepo（apps/web + apps/api）**：三仓库已初始化并托管在 GitHub，各自独立发布节奏更清晰；前后端通过 REST API 契约协作，`docs/API-CONVENTIONS.md`（位于 backend 仓库）是唯一 API 契约源。代价是无法共享 TS 类型包——Phase 2 如需共享类型，再评估引入 `packages/shared` 或 OpenAPI 代码生成。

分支规范（三仓库一致）：`master`（主干）→ `dev`（开发）→ `YYMMDD`（日常开发分支）。

## 3. 技术选型

### 前端 bailing-ui

- **Next.js 15 App Router**：服务端渲染能力满足 B2B SEO 诉求；Server Components 优先，客户端交互按需下沉。
- **TypeScript + Tailwind CSS v4 + shadcn/ui**：Tailwind v4 CSS-first 配置；shadcn 组件按需添加（`npx shadcn add`），不锁定整库。
- 页面与业务逻辑分离；SEO 保留 Metadata API / 动态路由 / sitemap 扩展点。

### 后端 bailing-backend

- **NestJS 11**：模块化分层（Controller 薄、Service 厚），内置 DI / 管道 / 过滤器体系，适合长期演进。
- **Prisma 6**：Schema 即文档；迁移文件唯一权威，禁止手改库结构。
- **REST API**：前缀 `/api/v1`，为后续多版本留空间。
- 全局 ValidationPipe（白名单 + 拒绝未知字段）、全局异常过滤器、统一响应拦截器。
- CORS 显式 Origin 白名单，**禁止 `*`**。

### 数据库 PostgreSQL 17（本地 Docker）

- 免费、本地可跑：`infrastructure/docker/docker-compose.yml` + 命名卷持久化。
- 端口仅绑定 `127.0.0.1`，不暴露公网；`pg_isready` 健康检查；`unless-stopped` 重启策略。
- Prisma 惰性连接：数据库不在线时应用照常启动，`/health` 保持存活响应，`/health/ready` 返回 503。

### 本阶段明确不引入

Redis、微服务、消息队列、Kubernetes、Swagger（已预留扩展位）、付费托管数据库。

## 4. 数据模型（Phase 1）

六张基础表（详见 `prisma/schema.prisma`）：`AdminUser`、`Category`、`Product`、`Inquiry`、`BlogPost`、`MediaAsset`。

设计要点：

- 主键统一 cuid；`createdAt` / `updatedAt` 全模型覆盖。
- `slug` 唯一索引（Product / Category / BlogPost）——SEO URL 基础。
- 询盘枚举 `InquiryStatus`（NEW → IN_PROGRESS → QUOTED → CLOSED）。
- `MediaAsset.provider` 预留 `TENCENT_COS`（Phase 2+ 再实现上传抽象层，本阶段只登记 URL）。
- 外键策略：产品→分类 `Restrict`（防止误删有产品的分类），其余可空外键 `SetNull`。

## 5. 安全与配置原则

- 密钥只走环境变量；`.env` 一律 gitignore；真实密码不出现在示例文件与文档。
- 前端 `NEXT_PUBLIC_` 变量视为公开，禁止放任何敏感信息。
- 500 错误对外只回固定文案，堆栈只进服务端日志。
- 生产环境必须使用独立变量（`PROD_*` 占位符已在 `.env.example`），禁止复用开发密钥。

## 6. 部署原则（未来）

已购资源与规划：

- **腾讯云海外服务器**：运行前后端 + PostgreSQL（Docker Compose，与本地同构）。
- **腾讯云 COS**：产品图片与媒体文件（Phase 2+ 通过 `MediaAsset` 接入）。
- **腾讯云 CDN**：静态媒体加速（域名指向 COS 源站）。
- **阿里云域名**：DNS 解析管理。
- **企业邮箱**：询盘通知（Phase 2+）。

原则：本地先行（Docker Compose 同构部署）、配置外置、密钥独立、数据库定期备份（pg_dump + 卷快照）——具体备份脚本在 Phase 2 落地。

## 7. 已否决 / 延后的方案

| 方案 | 结论 |
| --- | --- |
| monorepo + pnpm workspace | 延后：三仓库已存在；如需共享类型再评估 |
| 云托管数据库（RDS 等） | 否决（本阶段）：本地 Docker 免费且满足开发 |
| GraphQL | 否决：B2B 站点 REST 足够，减少复杂度 |
| Swagger 即装即用 | 延后：接口少，契约以本文档 + 代码注释维护 |
