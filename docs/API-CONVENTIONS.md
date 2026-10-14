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
