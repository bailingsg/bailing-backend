# API 规范（API Conventions）

> 本文档是 bailingsg 三仓库之间唯一的 API 契约源。后端实现必须遵守；前端仅可依据本文档调用 API。

## 1. 基础约定

- 基地址：本地开发 `http://127.0.0.1:4000`（或 `localhost:4000`）；未来生产 `https://api.bailingwooden.com`。
- 全局前缀：`/api/v1`。新增资源一律挂在该前缀下。
- 传输格式：JSON（`Content-Type: application/json`）。
- 时间格式：ISO 8601 UTC（如 `2026-10-13T03:33:35.882Z`）。

## 2. 统一响应结构

### 成功（经 `TransformInterceptor` 包装）

```json
{
  "success": true,
  "data": { "status": "ok" }
}
```

### 失败（经 `HttpExceptionFilter` 包装）

```json
{
  "success": false,
  "error": {
    "code": 400,
    "message": "Validation failed",
    "details": { "validationErrors": ["email must be an email"] }
  }
}
```

- `code`：HTTP 状态码；预留业务错误码（数字/字符串）扩展位。
- `message`：面向客户端的安全文案，**禁止**包含堆栈、SQL、连接串、密钥。
- `details`：可选，如 class-validator 校验明细数组。
- 未捕获异常统一返回 `500` + `"Internal server error"`，真实堆栈只进服务端日志。

## 3. 状态码使用

| 状态码 | 场景 |
| --- | --- |
| 200 | 查询成功 |
| 201 | 创建成功（Phase 2+） |
| 400 | 参数校验失败（ValidationPipe） |
| 404 | 路由不存在 / 资源不存在 |
| 409 | 唯一约束冲突（Phase 2+） |
| 500 | 未预期服务端错误 |
| 503 | 服务未就绪（当前用于 `/health/ready` 数据库不可用） |

## 4. 参数校验

- 全局 `ValidationPipe`：`whitelist: true`（剥离未声明字段）、`forbidNonWhitelisted: true`（存在未知字段直接 400）、自动 `transform`。
- DTO 使用 `class-validator` 装饰器；入参类型集中在 `*.dto.ts`，与 Controller 分离。
- Controller 保持“薄”：只做协议适配；业务逻辑在 Service；数据访问只允许经过 PrismaService。

## 5. CORS

- 后端 `CORS_ORIGINS` 显式白名单（逗号分隔），当前开发值：`http://localhost:3000,http://127.0.0.1:3000`。
- **禁止 `*`**；生产环境必须显式列出站点域名。
- 允许方法：`GET, POST, PUT, PATCH, DELETE, OPTIONS`；允许头：`Content-Type, Authorization`。

## 6. 健康检查端点

| 端点 | 语义 | 依赖 | 失败语义 |
| --- | --- | --- | --- |
| `GET /api/v1/health` | 存活（liveness） | 无 | 进程挂了自然不可达 |
| `GET /api/v1/health/ready` | 就绪（readiness） | 数据库 `SELECT 1` | 返回 `503` + 统一错误结构 |

设计意图：数据库抖动时，`/health` 仍可探测（进程健康），`/ready` 失败（负载均衡据此摘除节点）——两者分离是后续容器化部署的基础。

## 7. 版本演进

- 破坏性变更：升 `/api/v2`，旧版保留一个弃用周期；或在响应头声明弃用。
- 新增字段：只能追加（老客户端忽略未知字段，配合 `whitelist` 语义注意双向兼容）。
- 任何 API 行为变更必须同步更新本文档与 `docs/DEVELOPMENT-LOG.md`。

## 8. 当前端点清单（Phase 4.1）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | 公开 | 存活检查 |
| GET | `/api/v1/health/ready` | 公开 | 就绪检查（含数据库） |
| GET | `/api/v1/products` | 公开 | 产品列表（`page` / `pageSize`≤48 / `category` / `featured`） |
| GET | `/api/v1/products/:slug` | 公开 | 产品详情（未发布或不存在 → 404） |
| GET | `/api/v1/categories` | 公开 | 产品分类列表（含 `productCount`） |
| POST | `/api/v1/rfq` | 公开 | 提交询盘（201 / 400） |
| GET | `/api/v1/rfq` | X-Admin-Token | 询盘列表（分页 + 状态筛选） |
| GET | `/api/v1/rfq/:id` | X-Admin-Token | 询盘详情 |
| PATCH | `/api/v1/rfq/:id/status` | X-Admin-Token | 状态流转 |
| POST | `/api/v1/auth/login` | 公开 | 管理员登录 → JWT accessToken |
| GET | `/api/v1/auth/me` | JWT | 当前登录管理员 |
| GET | `/api/v1/cms/stats` | JWT | Dashboard 真实统计（询盘 / 产品 / 分类 / 文章） |

### 产品接口约定

- **只读**：产品写入（新增/编辑）属 CMS 阶段，本阶段不提供任何写接口。
- **可见性**：仅返回 `status = PUBLISHED`；`DRAFT` / `ARCHIVED` 一律不可见，避免草稿泄漏。
- **不存在与未发布统一返回 404**，不区分二者，避免通过状态差异探测未公开产品。
- **禁止电商字段**：响应中不含 `price` / `stock` / `sku` / `rating` / `review`（百灵木业为 B2B 制造商，不做在线零售）。
- **契约稳定**：数据库字段变化不直接泄漏到响应，统一经 `product.dto.ts` 的 mapper 转换。

## 9. 鉴权（Phase 4.1 已落地）

### JWT 方案

- **登录**：`POST /api/v1/auth/login`，请求 `{ "email", "password" }`；
  成功返回 `{ "accessToken", "user": { "id", "email", "role", ... } }`。
  失败（口令错误 / 邮箱不存在 / 账号停用）**统一 401 `Invalid email or password`**，
  不区分原因，防止账号枚举。
- **调用**：受保护接口携带 `Authorization: Bearer <accessToken>`。
- **有效期**：`JWT_EXPIRES_IN`（默认 `15m`）。**只实现 access token，
  不实现 refresh token**——15 分钟窗口 + HttpOnly Cookie 会话可满足后台场景；
  刷新机制待后续阶段按需引入（届时必须同时设计吊销策略）。
- **密钥**：`JWT_SECRET` 仅来自环境变量；代码无默认值，生产缺失或不足 32 字符直接启动失败
  （见 `src/config/env.validation.ts`）。
- **多重校验**：`GET /auth/me` 以数据库实时状态为准——账号被停用/删除后既有令牌立即失效，
  不只依赖 JWT 自然过期。

### 守卫（两套并存，迁移期约定）

| 守卫 | 请求头 | 适用范围 |
| --- | --- | --- |
| `JwtAuthGuard` | `Authorization: Bearer <JWT>` | 新增 CMS 接口（当前 `/cms/*`） |
| `AdminTokenGuard` | `X-Admin-Token: <共享密钥>` | RFQ 后台接口（Phase 3.7 兼容，保持不破坏） |

RFQ 后台接口将在后续阶段逐步迁移到 `JwtAuthGuard`；迁移完成前两者行为互不影响。

### 密码与安全约定

- 口令仅以 **bcrypt（cost 12）哈希** 存入 `admin_users.passwordHash`，禁止明文。
- 登录失败执行同等成本的占位哈希比较，抹平「邮箱是否存在」的响应时间差。
- 响应一律经 `toAdminProfile` 挑选字段，`passwordHash` 永不出现在任何响应中。
- 前端持有方式为 **HttpOnly Cookie**（SameSite=Lax + Secure），不落 localStorage。

## 10. Products CMS（Phase 4.2 已落地）

全部位于 `/api/v1/cms/` 前缀下，**均受 `JwtAuthGuard` 保护**（`Authorization: Bearer <JWT>`）。
分页与筛选由查询参数驱动；写操作返回统一信封。

### 分类 `/cms/product-categories`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cms/product-categories` | 分类列表（含 `productCount`，按 `sortOrder` 升序） |
| POST | `/cms/product-categories` | 创建（`name` 2–120、`slug` 格式校验、`description?`、`sortOrder?`、`isActive?`） |
| PATCH | `/cms/product-categories/:id` | 部分更新（全部字段可选） |
| DELETE | `/cms/product-categories/:id` | 删除；**分类下有产品返回 400**（与数据库 RESTRICT 语义一致的友好提示） |

错误码：slug 唯一冲突 → **409**；不存在 → **404**。

### 产品 `/cms/products`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cms/products` | 列表：`page`（默认 1）、`limit`（默认 20，最大 100）、`keyword`（匹配 name/shortDescription/description，不区分大小写）、`status`、`categoryId` |
| POST | `/cms/products` | 创建（`status` 默认 `DRAFT`、`isFeatured` 默认 `false`） |
| GET | `/cms/products/:id` | 详情（编辑页数据源） |
| PATCH | `/cms/products/:id` | 部分更新（仅更新提供的字段） |
| DELETE | `/cms/products/:id` | 删除产品并**级联清理磁盘图片文件** |
| POST | `/cms/products/:id/images` | 上传图片（`multipart/form-data`，字段 `file` + `alt?` + `sortOrder?` + `isPrimary?`） |
| DELETE | `/cms/products/:id/images/:imageId` | 删除图片（删行 + 删文件；删主图自动提升最早一张为新主图） |

错误码：slug 冲突 → **409**；不存在 → **404**；分类不存在 / specifications、applications 结构非法 → **400**；
图片 MIME/扩展名不受支持或**魔数校验失败**（伪造 MIME）→ **400** 且落盘文件即删。

### 图片上传安全约定

- 白名单 MIME：`image/jpeg` / `image/png` / `image/webp` / `image/avif`（multer `fileFilter` 校验，MIME 与扩展名必须同源白名单）。
- 大小限制：默认 5MB（`UPLOAD_MAX_FILE_SIZE` 字节可配）。
- 落盘文件名由服务端生成（UUID + 白名单扩展名），**绝不使用客户端原始文件名**。
- 存储目录：`<backend>/uploads/products/`（`.gitignore` 已排除），静态前缀 `/uploads/products`。
- 内容校验：落盘后服务端做**魔数校验**（JPEG `FF D8 FF` / PNG / `RIFF****WEBP` / `ftyp`+avif），失败即删文件并 400。
- 入库 URL 基地址由 `UPLOADS_BASE_URL` 配置（默认后端自身地址，生产可指向 CDN）。
- 主图唯一：同一产品同时最多一张 `isPrimary=true`；首图自动成为主图。

## 11. Media CMS 媒体资源库（Phase 4.3 已落地）

全部位于 `/api/v1/cms/media`，**控制器级 `JwtAuthGuard`**（`Authorization: Bearer <JWT>`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/cms/media/upload` | 上传（`multipart/form-data`，字段 `file`）；成功 **201**，返回 `{ id, url, filename, mimeType, size, … }` |
| GET | `/cms/media` | 列表：`page`（默认 1）、`limit`（默认 20，最大 100）、`keyword`（匹配 originalName/filename，不区分大小写）、`category`（`IMAGE` / `DOCUMENT`） |
| GET | `/cms/media/:id` | 详情；不存在 → **404** |
| DELETE | `/cms/media/:id` | 删除；**被业务引用时返回 400 `Media asset is in use.`**；成功返回 `{ id }` |

### 存储抽象（Storage Adapter）

业务模块 → `MediaService` → `StorageProvider` → Local / COS / CDN。
`STORAGE_PROVIDER` 环境变量切换实现（`LOCAL` 默认；`TENCENT_COS` 为 Phase 4.3 预留接口，未实现前配置即启动失败并给出指引）。
**业务代码不得直接操作文件系统**，一切落盘/删除都经 Provider。

### 上传安全约定

- 白名单 MIME：`image/jpeg` / `image/png` / `image/webp` / `image/avif`。
- 大小限制：默认 10MB（`MEDIA_MAX_FILE_SIZE` 字节可配）；超限由平台层映射为 **413 Payload Too Large**。
- 服务端生成存储键 `media/<YYYY>/<MM>/<uuid>.<ext>`（`storageKey`，逻辑命名空间；物理路径 `<MEDIA_UPLOAD_DIR>/<YYYY>/<MM>/<uuid>.<ext>`）。
- 文件以**内存存储**接收，落盘由 Provider 完成；文件名一律 UUID，**绝不使用客户端原始文件名**（原始名仅清洗后存 `originalName` 供展示）。
- **魔数校验**：确认真实图片格式（JPEG/PNG/WebP/AVIF 文件头），失败 → 400。
- 尺寸解析：从文件头解析宽高（PNG IHDR / JPEG SOF / WebP VP8-VP8L-VP8X / AVIF ispe），失败置 `null`。
- 防路径穿越：`storageKey` 先过白名单正则，再过 resolved-path 目录包含校验（双保险）。
- 响应 DTO **不含服务器真实路径**（`storageKey` 是对象键，不是文件系统路径）。
- 静态访问：`/uploads/media/**`（本地 Provider 生成的 URL 为 `${UPLOADS_BASE_URL}/uploads/<storageKey>`；未来切 CDN 只换 Provider 的 `getUrl`）。

---

## 12. Blog CMS 博客内容管理（Phase 4.4 已落地）

全部位于 `/api/v1/cms/blog`，**控制器级 `JwtAuthGuard`**（`Authorization: Bearer <JWT>`）。

### 文章 `/cms/blog/posts`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cms/blog/posts` | 列表：`page`（默认 1）、`limit`（默认 20，最大 100）、`keyword`（匹配 title/slug/excerpt）、`status`（`DRAFT` / `PUBLISHED`）、`categoryId`、`tagId`、`featured` |
| GET | `/cms/blog/posts/:id` | 详情（含 `content` / SEO / OG / Twitter / `tags` / `coverMedia`）；不存在 → **404** |
| POST | `/cms/blog/posts` | 创建；成功 **201**。正文经白名单净化；状态置 `PUBLISHED` 且未传 `publishedAt` 时后端自动回填当前时间 |
| PATCH | `/cms/blog/posts/:id` | 更新（仅传提供的字段；可选字段显式传 `null` 表示清空） |
| DELETE | `/cms/blog/posts/:id` | 删除；级联移除 `blog_post_tags` 关联；成功返回 `{ id }` |

### 分类 `/cms/blog/categories`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cms/blog/categories` | 列表，含 `postCount`，按 `sortOrder` 升序 |
| POST | `/cms/blog/categories` | 创建；`slug` 唯一，冲突 → **409** |
| PATCH | `/cms/blog/categories/:id` | 更新 |
| DELETE | `/cms/blog/categories/:id` | 删除；**分类下仍有文章时返回 400**（先迁移或清空文章） |

### 标签 `/cms/blog/tags`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cms/blog/tags` | 列表，含引用计数，按名称升序 |
| POST | `/cms/blog/tags` | 创建；`slug` 唯一 |
| PATCH | `/cms/blog/tags/:id` | 更新 |
| DELETE | `/cms/blog/tags/:id` | 删除；级联解绑全部文章关联 |

### Slug 约定（产品与博客共用）

`src/common/validators/slug.ts` 为单一来源：

- 正则：`^[a-z0-9]+(?:-[a-z0-9]+)*$`
- 仅小写字母、数字与连字符；用于 `/blog/[slug]`、`/blog/category/[slug]` 等 SEO 友好 URL
- `slug` 在各自表内唯一，冲突返回 **409**

### 富文本安全约定

正文写入前必须经 `rich-text.sanitizer.ts` 白名单净化（**不依赖第三方库**）：

- **标签白名单**：`h1`–`h6` / `p` / `br` / `hr` / `strong` / `em` / `u` / `s` / `blockquote` / `ul` / `ol` / `li` / `a` / `img` / `code` / `pre` / `span` / `div` / 表格系列
- **逐标签属性白名单**：`a` 仅 `href/title/target/rel`；`img` 仅 `src/alt/title/width/height`；其余标签仅保留 `class`
- **URL 协议白名单**：仅 `http` / `https` / `mailto` / `tel` / 相对路径；`javascript:` / `vbscript:` / 非图片 `data:` 一律丢弃
- **危险标签连同内容删除**：`script` / `style` / `iframe` / `object` / `embed` / `form` / `input` 等
- **实体解码 + 控制字符过滤**：防 `java&#115;cript:` 类绕过
- 文档外壳（`html`/`head`/`body`）**丢标签、保留正文**（兼容 Word / 网页粘贴）；void 元素自闭合处理，不吞后续内容

### 图片与媒体关联约定

- **博客模块不自行存储图片**：正文插图与封面一律通过 Phase 4.3 媒体库（`/cms/media`）选取，前端只读浏览、不在此上传
- 封面双字段：`coverMediaId`（关联 `MediaAsset`，推荐）+ `coverImageUrl`（URL 快照，兼容历史外链 / CDN 直链）
- **媒体删除保护已扩展**：被 `ProductImage` **或** `BlogPost.coverImageUrl` 引用的媒体，`DELETE /cms/media/:id` 返回 **400 `Media asset is in use.`**

### SEO / Open Graph / Twitter Card 字段

| 字段 | 用途 | 回落规则（公开站消费时） |
| --- | --- | --- |
| `seoTitle` | `<title>` | 空则回落 `title` |
| `seoDescription` | `<meta name="description">` | 空则回落 `excerpt` |
| `seoKeywords` | `<meta name="keywords">` | 逗号分隔，无回落 |
| `canonicalUrl` | `<link rel="canonical">` | 跨站转载指向原文 |
| `ogTitle` / `ogDescription` / `ogImage` | Open Graph | 空则分别回落 `seoTitle` / `seoDescription` / `coverImageUrl` |
| `twitterTitle` / `twitterDescription` | Twitter Card | 空则回落 `ogTitle` / `ogDescription` |

> OG / Twitter 字段为 Phase 4.4 **预留**：本阶段只做存储与 API 透出，不接入第三方校验，公开站接入时直接消费。

---

## 13. Enterprise CMS：Factory / Quality / Applications（Phase 4.5 已落地）

三大企业内容模块，**全部复用** Phase 4.1 JWT、Phase 4.2 Product、Phase 4.3 MediaAsset，
不新建媒体/产品基表。管理端前缀 `/cms/{factory,quality,applications}`（**全部 JwtAuthGuard 保护**），
公开端前缀 `/public/{factory,quality,applications}`（**无需鉴权，只读**）。

### 通用内容状态

新增独立枚举 `ContentStatus { DRAFT, PUBLISHED }`（**刻意**与博客的 `PostStatus` 分开，
企业内容的发布语义与文章不同）。规则：

- 管理端可读写任意状态；公开端 where 恒带 `status = PUBLISHED`
- **详情按 slug 查询非 PUBLISHED 记录一律返回 404**（不泄露「存在但未发布」）
- slug 唯一（`@unique`），重复创建/改名 → **409**
- List 排序：`sortOrder asc, publishedAt desc, createdAt desc`
- 发布语义由服务端 `resolvePublishedAt` 统一决定：显式传值优先；`PUBLISHED` 且无值 → 取
  `existing ?? now`；`DRAFT` → **保留原值**（撤回不清空历史发布时间）

### Factory `/cms/factory`（工厂实力）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cms/factory` | 列表（page/limit/keyword/sectionType/status） |
| POST | `/cms/factory` | 创建（含图片、展会） |
| GET | `/cms/factory/:id` | 详情 |
| GET | `/cms/factory/:id/exhibitions` | 该分区展会列表 |
| PATCH | `/cms/factory/:id` | 更新 |
| DELETE | `/cms/factory/:id` | 删除（**只删分区与其关联行，绝不删 MediaAsset**） |

- `sectionType ∈ OVERVIEW / FACILITY / EQUIPMENT / PRODUCTION / LOADING / EXHIBITION`
- 媒体：`coverMediaId`（封面）+ `images[]`（图库，可 ALT / 排序 / 解除关联）
- **`FactoryImage.exhibitionId` 为可空**：`null` = 通用图库；非空 = 归属某场展会照片
- 展会为**结构化模型**（`FactoryExhibition` + `heldOn/location/description/isVisible/sortOrder`），
  **不是一个大 JSON 字段**；不另建独立 Events/Exhibition CMS
- 展示口径：图库计数只统计 `exhibitionId === null`；公开端展会仅返回 `isVisible = true`

### Quality `/cms/quality`（质量体系）

| 方法 | 路径 |
| --- | --- |
| GET / POST | `/cms/quality` |
| GET / PATCH / DELETE | `/cms/quality/:id` |

- `recordType ∈ CERTIFICATION / TEST_REPORT / QUALITY_CONTROL / STANDARD`
- 字段 `issuer / certificateNumber / issueDate / expiryDate` **全部可空**——
  `QUALITY_CONTROL` 类记录通常没有编号与有效期，**留空即存 null，禁止任何推断或占位**
- 部分更新语义：仅当 `dto.expiryDate !== undefined` 才写入（`''` → `null`），
  未提交的字段绝不被覆盖
- 文件通过媒体库关联（`mediaId`，支持 PDF 与图片）；**未发布记录的证书不会从公开接口读出**
- 到期提示（后台）为**克制文案**：仅有真实到期日时给出「已到期 / N 天后到期 / 安全」，
  **缺失日期一律不提示**

### Applications `/cms/applications`（产品应用场景）

| 方法 | 路径 |
| --- | --- |
| GET / POST | `/cms/applications` |
| GET / PATCH / DELETE | `/cms/applications/:id` |

- 关联产品为**显式多对多** `ApplicationProduct(applicationId, productId, sortOrder)`，
  `@@id([applicationId, productId])`；**不使用产品名称字符串匹配**
- 更新时 `products[]` 为**整体替换**（差集删除 + `upsert` 保留 sortOrder），并做 `dedupeProducts`
- **删除场景只级联删除关联行，绝不删除 Product**（Product 侧 `onDelete: Restrict`）
- `featured` 布尔推荐位；列表可 `featured=true|false` 过滤

### 公开只读接口 `/public/*`

| 路径 | 说明 |
| --- | --- |
| `GET /public/factory` `?page&pageSize` | 已发布工厂分区列表（含图库/展会计数） |
| `GET /public/factory/:slug` | 详情（图库 = `exhibitionId null`；展会仅 `isVisible`） |
| `GET /public/quality` `?page&pageSize` | 已发布质量记录列表 |
| `GET /public/applications` `?page&pageSize` | 已发布应用场景列表 |
| `GET /public/applications/:slug` | 详情（关联产品仅 `status = PUBLISHED`） |

- `pageSize` 上限 **48**；`page` 从 1 起
- **响应字段显式白名单**：绝不透出 `storageKey / createdBy / provider / status / sortOrder / createdAt / updatedAt`
  （已在 e2e 中用原始 JSON 字符串扫描断言）
- 质量记录附带 `isExpired` 计算值：**无到期日时返回 `null`**（不臆断「已过期」）
- 应用场景封面产品图取 `ProductImage.isPrimary`（**非** `isCover`）

### 媒体引用保护（已扩展至三模块）

`MediaService.countReferences` 现覆盖：Product 图片、Blog 封面、Factory（封面 + 图库）、
Quality（文件）、Application（封面）。被任一引用时 `DELETE /cms/media/:id` → **400 `Media asset is in use.`**

### 校验与安全约定

- 所有写操作走全局 `ValidationPipe`（whitelist + forbidNonWhitelisted + transform），
  DTO 校验失败 → **400**
- slug 正则与消息共享 `src/common/validators/slug.ts`（`SLUG_PATTERN/SLUG_REGEX/SLUG_MESSAGE`）
- Factory 正文 HTML 经自建白名单净化器 `sanitizeRichText`（同博客，无第三方依赖）
- 媒体存在性校验：`coverMediaId/mediaId` 指向不存在的资产 → **400**（不落库悬空外键）
- RBAC **本阶段不实现**，但在 controller 层级以注释标注未来接入点（避免散落硬编码权限判断）

