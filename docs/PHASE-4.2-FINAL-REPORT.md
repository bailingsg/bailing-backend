# Phase 4.2 Final Report

> 百灵木业 CMS Products 产品管理系统 —— 2026-10-14 完成
> 分支：`bailing-backend` / `bailing-admin` 均位于 `261014`

## A 状态

COMPLETE

后台可登录访问：http://localhost:3001/login（凭据见 `bailing-backend/.env`；两个服务均在运行：backend 4000 / admin 3001）。
产品管理入口：侧边栏 Products / Categories，或直接访问 `/products`、`/categories`。

### 完成标准核对

✅ 产品分类 CRUD（`/api/v1/cms/product-categories`，全 JWT 保护）
✅ 产品 CRUD（分页 + keyword / status / categoryId 筛选）
✅ 产品图片管理（本地 `uploads/products/`，类型/大小白名单 + 魔数校验）
✅ 状态管理（DRAFT / PUBLISHED / ARCHIVED，创建默认 DRAFT）
✅ SEO 管理（seoTitle / seoDescription）
✅ DTO 强校验（class-validator：slug 正则、长度、JSON 结构自定义约束）
✅ 全部 CMS API 挂 `/api/v1/cms/` 且 JwtAuthGuard 保护（11 端点 401 矩阵验证）
✅ Admin：列表（图/名/分类/状态/Featured/更新时间/操作 + 搜索/筛选）、创建页、编辑页（表单复用 + 图片管理 + 删除产品）、分类管理页
✅ 测试通过（后端 82/82，运行时验证 29/29，浏览器全流程 10/10）
✅ lint / typecheck / nest build / next build / migrate 零漂移全部通过

## B Database

- **模型**：沿用既有 `Category` / `Product` / `ProductImage`（Phase 1–3.5 已建立）。本阶段**无新建模型**。
- **唯一新增迁移**：`20261014120152_add_product_applications` —— `ALTER TABLE "products" ADD COLUMN "applications" JSONB;`
  （产品应用标签数组）。流程遵循项目安全规范：手写 SQL → `prisma migrate deploy` → `prisma generate` → `migrate diff` 验证输出为空（无漂移）。未触碰任何历史迁移。
- **迁移状态**：`prisma migrate status` = up to date（4 migrations found）。
- **漂移校验**：`prisma migrate diff --from-schema-datasource --to-schema-datamodel --script` 输出 "This is an empty migration" —— **无漂移**。
- **向后兼容**：保留 `Product.application String?` 单值列；对外 DTO 的 `application` 字段在为空时可回退 `applications[0]`，公开产品 API 行为不变。
- **级联语义**：`ProductImage → Product` 为 schema 级 `onDelete: Cascade`；`Product.category` 为 `Restrict`（服务层提前给出友好 400，与数据库语义一致）。

## C Backend

模块位置：`src/modules/cms/products/`（module / controller / service / dto / entities / upload.options），经 `cms.module.ts` 装配。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/cms/product-categories` | 分类列表（含 productCount，sortOrder 升序） |
| POST | `/api/v1/cms/product-categories` | 创建分类（slug 冲突 409） |
| PATCH | `/api/v1/cms/product-categories/:id` | 部分更新 |
| DELETE | `/api/v1/cms/product-categories/:id` | 删除（有产品 400，不存在 404） |
| GET | `/api/v1/cms/products` | 列表：page/limit(≤100)/keyword/status/categoryId |
| POST | `/api/v1/cms/products` | 创建（默认 DRAFT / isFeatured=false） |
| GET | `/api/v1/cms/products/:id` | 详情（编辑页数据源） |
| PATCH | `/api/v1/cms/products/:id` | 部分更新（仅提供的字段） |
| DELETE | `/api/v1/cms/products/:id` | 删除产品（先删磁盘文件再删行） |
| POST | `/api/v1/cms/products/:id/images` | 上传图片（multipart：file + alt/sortOrder/isPrimary） |
| DELETE | `/api/v1/cms/products/:id/images/:imageId` | 删除图片（删行 + 删文件 + 主图自动提升） |

- **错误映射**：P2002 → 409（slug 冲突）；P2025 → 404；分类不存在 → 400；伪造成图片内容 → 400 且即删文件。
- **DTO 校验**（`whitelist` + `forbidNonWhitelisted` 全局管道之上）：
  - slug：`^[a-z0-9]+(?:-[a-z0-9]+)*$`（与公开产品 URL 约定一致）；
  - `IsSpecificationsConstraint`：JSON 对象，≤50 项、键 1–60 字符、值 ≤300；
  - `IsApplicationsConstraint`：字符串数组，≤20 项、每项 ≤60 字符；
  - name 2–200、description 10–20000、seoTitle ≤200、seoDescription ≤500 等长度约束。
- **图片安全**（`upload.options.ts`）：
  - MIME 白名单 image/jpeg · png · webp · avif，且**扩展名必须与 MIME 同属白名单**（multer `fileFilter`）；
  - 大小默认 5MB（`UPLOAD_MAX_FILE_SIZE` 可配）；
  - 落盘文件名 = UUID + 白名单扩展名，**永不使用客户端原始文件名**（防路径穿越）；
  - **魔数校验**：JPEG `FF D8 FF` / PNG / `RIFF****WEBP` / `ftyp`+avif，失败即删文件并 400；
  - 删除按 URL 取文件名前过 `safeFileNameFromUrl` 白名单正则，再拼目录，双重防穿越。
- **静态资源**：`app.setup.ts` 以 `useStaticAssets(UPLOAD_ROOT, { prefix: '/uploads', maxAge: '7d' })` 挂载；`uploads/` 已加入 `.gitignore`。

## D Admin

位置：`bailing-admin/src/app/(dashboard)/products/**` 与 `/categories/**`，新增加权层 `src/lib/products.ts`。

- **`/products` 列表**：表格列 = 图片（主图缩略）/ 名称 / 分类 / 状态徽章 / Featured / 更新时间 / 操作（编辑、两步确认删除）；keyword 搜索 + 分类下拉 + 状态筛选 + 分页，全部由 URL 参数驱动、服务端渲染；移动端降级为卡片列表。
- **`/products/create` 与 `/products/[id]/edit` 复用同一 `ProductForm`**：基本信息 / 应用标签（TagInput，隐藏字段 JSON 序列化）/ 规格参数（JSON 编辑器，前后端双重校验）/ 发布状态与 SEO。编辑页另含图片管理侧栏（上传、alt/sortOrder/主图、列表缩略、两步确认删除）与危险区删除产品。
- **`/categories`**：新建表单 + 行内编辑 + 两步确认删除；含产品的分类禁用删除并显示产品数。
- **安全边界**：所有写操作走**服务端 Actions**——JWT 只在服务端从 HttpOnly Cookie 读取并转发，浏览器 JS 不接触令牌；`authorizedRequest` 401 时统一提示重新登录。上传专用函数不预设 `Content-Type`，由 fetch 生成 multipart boundary。
- **路由保护**：middleware matcher 增加 `/products/:path*`、`/categories/:path*`（Cookie 存在性快判）；页面级 `requireAdmin` 以 JWT 调 `/auth/me` 复核（双层，与 Phase 4.1 一致）。
- **设计系统**：全部复用 Phase 3.2 组件（Button/Card/Badge/Input/Select/Textarea/Label/Container/PageHeader），无新增视觉令牌。

## E Security

- **鉴权**：11 个 CMS 端点（products ×6 + product-categories ×5）控制器级 `JwtAuthGuard`，无令牌 / 伪造令牌 / 篡改令牌一律 401（e2e 矩阵逐点验证）。
- **令牌边界**：JWT 不落 localStorage、不进 URL、不出服务端；浏览器只持有 HttpOnly Cookie（SameSite=Lax + Secure，Max-Age 与 15m 令牌一致）。
- **口令与响应**：延续 Phase 4.1（bcrypt cost 12、防账号枚举统一文案、`passwordHash` 永不出响应）；本阶段无新增认证面。
- **上传安全**：类型白名单（MIME + 扩展名同源）→ 大小限制 → UUID 文件名 → 魔数内容校验 → 删除时路径白名单，五层防护；失败路径（产品不存在 / 魔数失败 / 写库失败）均保证**磁盘文件被清理**（单测 + e2e + 运行时验证三重确认）。
- **不破坏既有系统**：RFQ 公开提交与 `X-Admin-Token` 后台通道零改动；Phase 4.1 全部 35 项测试随全套重跑通过。
- **数据卫生**：`validationPipe` whitelist + forbidNonWhitelisted 拒绝未声明字段；JSON 字段经自定义 ValidatorConstraint 约束形状与规模。

## F Tests

**后端 jest 全套：7 suites / 82 例全部通过**（Phase 4.1 的 35 例不破坏 + 本阶段新增 47 例）。

- `test/products-cms.spec.ts`（单元，23 例）：分类 CRUD/productCount 聚合/409/400/404；产品列表分页信封与 keyword OR 三字段、参数夹紧、详情 404 与图片排序、create 默认值、PATCH 部分更新、分类存在性校验、删除顺序、图片首图默认主图、主图唯一化、魔数失败即删文件、产品不存在即删文件、非首图不设主图、删主图提升新主图、P2002→409。
- `test/products-cms.e2e-spec.ts`（端到端，24 例）：JWT 401 矩阵（11 端点）+ 伪造令牌；分类 CRUD 全流程（含 409/404/400）；产品 CRUD 全流程（重复 slug 409、分类不存在 400、DTO 六类非法 400、PATCH 部分字段余量不变、详情 404、更新 404/400）；列表 keyword/status/categoryId/分页信封/limit 上限/非法分页；图片上传（真 PNG 魔数）、第二张非主图、伪造 MIME 400 且无残留文件、非图片 MIME 400、缺 file 400、产品不存在 404 且无残留、删主图自动提升、删产品文件同步清理、静态路由可读；分类有产品禁删 400、产品删后可删分类。测试数据 `e2e-cms-` 前缀，afterAll 清理含磁盘文件。
- **质量门**：`npm run lint`（0 error）/ `npx tsc --noEmit`（0 error）/ `npx jest`（82/82）/ `npm run build`（nest）/ admin `next build`（含 lint 与类型检查）/ `prisma migrate diff` 空迁移。
- **Admin 构建产物路由**：`/categories`、`/products`、`/products/[id]/edit`、`/products/create` 全部就绪。

## G 浏览器全流程验证（真实 UI）

`docs/phase-4.2-verify.mjs`（API + 页面渲染，**29/29 通过**）+ `docs/phase-4.2-browser-flow.sh`（playwright-cli 真实浏览器操作，**10/10 通过**）：

1. 未登录访问 `/products`、`/categories` → 重定向登录页（middleware 新路由生效）；
2. 错误口令 401；正确登录 200 + HttpOnly Cookie；
3. 浏览器 UI 创建分类 → 列表出现；
4. 浏览器 UI 创建产品（下拉选择新分类）→ 跳转编辑页且表单回显；
5. 上传真实 PNG（file chooser）→ 首图默认主图；
6. 两步确认删除产品 → 返回列表且产品消失；测试分类删除成功；
7. 登出后 `/products` 回登录页。

过程中发现并修复两个真实问题：① 图片上传成功后「上传成功」提示因 revalidate 重挂载而消失（非缺陷，测试断言改为持久标记「主图」）；② 删除交互从原生 `confirm` 改造为页内两步确认（`button:has-text` 选择器冲突也随之解决）。

## H 偏离、风险与后续

- **技术栈偏离（如实记录）**：任务书 Phase 4.2 原文写 "Drizzle ORM + SQLite，禁止迁移 PostgreSQL"，与实际项目栈（Prisma 6 + PostgreSQL，Phase 4.1 全部构建于此，且数据库安全红线禁止 `migrate reset` / 破坏既有迁移）冲突。按「不修改现有技术栈」「不破坏 Phase 4.1」的最高优先级约束，**保持 Prisma + PostgreSQL**，仅新增一次 JSONB 增量迁移；其余条款（目录结构、接口形状、安全要求、测试要求、页面要求）全部按任务书执行。
- **已知限制**：① 无 refresh token（延续 Phase 4.1 决策，15m 窗口）；② 图片存本地磁盘，多实例部署需改共享存储/CDN（`UPLOADS_BASE_URL` 已预留）；③ 产品列表未做收藏/批量操作；④ 上传无图片尺寸/压缩处理（仅格式与魔数校验）。
- **后续阶段候选**：Blog CMS、Media 库（复用本阶段上传管道）、用户管理与 RBAC、RFQ 后台接口迁移至 JwtAuthGuard、产品排序拖拽。

## 交付物

**bailing-backend**（分支 `261014`）：`src/modules/cms/products/**`（11 端点）、`prisma/migrations/20261014120152_add_product_applications`、`test/products-cms.spec.ts`、`test/products-cms.e2e-spec.ts`、`docs/PHASE-4.2-FINAL-REPORT.md`、`docs/phase-4.2-verify.mjs`、`docs/phase-4.2-browser-flow.sh`、API-CONVENTIONS 第 10 节、DEVELOPMENT-LOG 第 9 节、README、eslint 配置（docs 脚本忽略）。

**bailing-admin**（分支 `261014`）：`src/lib/products.ts`、`src/app/(dashboard)/products/**`（列表/创建/编辑/图片管理/危险区）、`src/app/(dashboard)/categories/**`、`src/components/admin-sidebar.tsx`（启用 Products/Categories）、`src/middleware.ts`（保护新路由）、`src/lib/api.ts`（错误信息透传增强）、README。

