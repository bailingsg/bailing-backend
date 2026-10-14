# Phase 4.3 Final Report

**阶段**：Phase 4.3 — Media Library 媒体资源管理系统
**日期**：2026-10-14
**分支**：`261014`（自 `dev` 拉取，完成后 ff 合入 `dev`）
**仓库**：`bailing-backend`、`bailing-admin`

---

## A 状态

| 项 | 结果 |
| --- | --- |
| Storage Adapter 模式（接口 / Local 实现 / COS 预留） | ✅ 落地，业务零侵入可切换 |
| MediaAsset 模型与迁移 | ✅ 演扩 Phase 1 预留模型，零漂移 |
| Media CMS API（上传/列表/详情/删除 + 引用检查） | ✅ 全部 `JwtAuthGuard` |
| Admin `/media` 媒体库页面（画廊/拖拽上传/两步删除/搜索/预览） | ✅ 已上线（生产构建） |
| 文件校验（MIME 白名单 / 大小 / 魔数 / UUID 文件名 / 防穿越） | ✅ 全链路 |
| 测试与质量门 | ✅ lint / typecheck / build / **113/113** jest / 浏览器流程全 PASS |
| 破坏 Phase 4.1 / 4.2 既有功能 | ❌ 无（回归全绿） |
| 服务运行状态 | ✅ backend 4000 / admin 3001 / ui 3000，**本地与局域网（192.168.1.40）均可访问** |

---

## B Database

**决策：演扩 Phase 1 预留模型，不新建表。**

Phase 1 已存在 `media_assets` 表（`fileName` / `altText` / `provider`，以及 `enum MediaProvider { LOCAL, TENCENT_COS }`，
注释明确写着「provider 为腾讯云 COS 预留，Phase 2+ 再实现上传抽象层」）——与本次任务书「未来接入 COS / CDN」的目标完全吻合。
因此删除最初误加的重复模型，改为**演扩原模型**，保证迁移历史与既有数据零破坏（迁移时表为空，风险为零）。

迁移文件：`prisma/migrations/20261014151500_add_media_assets/migration.sql`（手写 SQL）

```sql
CREATE TYPE "MediaCategory" AS ENUM ('IMAGE', 'DOCUMENT');
ALTER TABLE "media_assets" RENAME COLUMN "fileName" TO "filename";
ALTER TABLE "media_assets"
  ADD COLUMN "originalName" TEXT NOT NULL,
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "category" "MediaCategory" NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN "createdBy" TEXT NOT NULL;
CREATE UNIQUE INDEX "media_assets_storageKey_key" ON "media_assets"("storageKey");
CREATE INDEX "media_assets_category_idx" / "media_assets_createdAt_idx" / "media_assets_createdBy_idx" ...
```

最终表结构（15 列）：`id` / `filename` / `originalName` / `storageKey`(unique) / `url` / `mimeType` / `size` /
`width?` / `height?` / `altText?` / `provider` / `category` / `createdBy` / `createdAt` / `updatedAt`。

验证：`migrate deploy` → `prisma generate` → `prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --script` 输出为空（**零漂移**）。

**ProductImage 迁移评估**：`ProductImage.url`（字符串）改为 `mediaId` 外键属高风险变更（涉及 Phase 4.2 既有数据与公开站读取路径），
本阶段**保留 `url` 字段**，仅让 MediaService 在删除时做引用检查（见 E）。未来迁移方案见 H。

---

## C Backend

### 目录（`src/modules/media/`）

| 文件 | 职责 |
| --- | --- |
| `storage/storage.interface.ts` | `StorageProvider` 接口（`upload` / `delete` / `getUrl` / `exists`）+ `STORAGE_PROVIDER` 注入令牌 |
| `storage/local-storage.provider.ts` | 本地磁盘实现：`storageKey` 生成、白名单正则 + 目录包含双重防穿越、删除静默 |
| `storage/cos-storage.provider.ts` | **腾讯云 COS 预留占位**：方法抛明确指引，头部注释写明接入步骤 |
| `media-file.util.ts` | MIME/大小校验、**魔数校验**、尺寸解析（PNG IHDR / JPEG SOF / WebP VP8·VP8L·VP8X / AVIF ispe） |
| `entities/media.entity.ts` | 对外 DTO（**不含服务器真实路径**）+ `toMediaAssetDto` |
| `dto/list-media-query.dto.ts` | 列表查询（page/limit≤100/keyword≤120/category） |
| `media.service.ts` | 上传 / 列表 / 详情 / 删除（引用检查） |
| `media.controller.ts` | `/cms/media`，类级 `JwtAuthGuard`，`memoryStorage` + 10MB limits + 201 |
| `media.module.ts` | `STORAGE_PROVIDER` 工厂（按环境变量选择实现） |

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/cms/media/upload` | multipart（字段 `file`）→ **201** `{ id, url, filename, mimeType, size, width, height, … }` |
| GET | `/api/v1/cms/media` | `page` / `limit` / `keyword` / `category`，返回分页信封 |
| GET | `/api/v1/cms/media/:id` | 详情（404 处理） |
| DELETE | `/api/v1/cms/media/:id` | 引用检查通过后删除（库行 + 磁盘文件）；被引用 → 400 |

### URL / 存储键策略

- `storageKey` = `media/<YYYY>/<MM>/<uuid>.<ext>`（**逻辑命名空间**）
- 物理路径 = `<MEDIA_UPLOAD_DIR>/<YYYY>/<MM>/<uuid>.<ext>`（默认 `MEDIA_UPLOAD_DIR=<backend>/uploads/media`）
- `url` 由 Provider 的 `getUrl` 生成：`${UPLOADS_BASE_URL}/uploads/<storageKey>`
- **未来接 CDN 只需替换 Provider 的 `getUrl`（或换 Provider 实现），业务代码与数据库结构零改动**

### 接线改动

- `src/config/configuration.ts`：新增 `storageProvider`（默认 `LOCAL`）
- `src/app.setup.ts`：媒体目录 `mkdirSync` + `/uploads/media` 静态挂载（`maxAge 7d`）
- `src/modules/cms/cms.module.ts`：`imports` 增加 `MediaModule`
- `src/common/filters/http-exception.filter.ts`：MulterError → 400 兜底映射（说明：经 `FileInterceptor` 的错误已被平台层先行转换）
- `.env.example`：新增 `STORAGE_PROVIDER` / `MEDIA_MAX_FILE_SIZE` / `MEDIA_UPLOAD_DIR` 文档

### 关键修复

**存储键双前缀 Bug**：`storageKey` 的 `media/` 前缀是逻辑命名空间，若直接与根目录拼接会得到
`uploads/media/media/<年>/…` → 静态路由 404。修复为 `resolvePath` 时剥离命名空间前缀（白名单正则仍要求 `media/` 前缀，保证 URL 与库内键一致）。

---

## D Admin

### 新增文件

| 文件 | 职责 |
| --- | --- |
| `src/lib/media.ts` | API 层（list/get/delete/upload）+ `formatFileSize` / `mediaTypeLabel` / 删除失败友好映射 |
| `src/app/(dashboard)/media/actions.ts` | Server Actions：`uploadMediaAction`（multipart 透传）/ `deleteMediaAction` |
| `src/app/(dashboard)/media/page.tsx` | 服务端渲染列表：搜索（URL 参数）、分页、统计 |
| `src/app/(dashboard)/media/media-library.tsx` | 客户端：拖拽上传区、画廊网格、两步删除、预览弹窗 |

### 功能对照任务书

| 要求 | 实现 |
| --- | --- |
| Gallery Grid（缩略图/文件名/类型/大小/上传时间/操作） | ✅ 响应式网格（2/3/4 列），卡片含类型徽标、大小、尺寸、时间 |
| 拖拽上传 | ✅ `onDragOver/onDrop` + 隐藏 input + 客户端预校验（类型/大小），成功后自动刷新 |
| 两步确认删除 | ✅ 「删除」→「确认删除 / 取消」，页内确认（不用原生 confirm） |
| 搜索 | ✅ 关键词（originalName / filename）经 URL 参数驱动服务端筛选 |
| 图片预览 | ✅ 弹窗（Escape / 点击遮罩关闭），展示大图 + 类型/大小/尺寸/时间/存储键/提供方 |
| 引用保护提示 | ✅ 后端 `Media asset is in use.` → 中文友好提示「该媒体正被产品图片引用，请先在产品编辑页移除引用后再删除」 |

### 其他改动

- `src/components/admin-sidebar.tsx`：Media 由 Coming Soon 改为可用（提示「媒体资源」）
- `src/middleware.ts`：matcher 增加 `/media/:path*`

---

## E Security

| 项 | 措施 |
| --- | --- |
| 鉴权 | 控制器级 `JwtAuthGuard`，四个端点全部要求 `Authorization: Bearer <JWT>`；Admin 侧 JWT 仅存 HttpOnly Cookie，经 Server Actions 转发，**浏览器不接触令牌** |
| 类型限制 | MIME 白名单 `image/jpeg` / `image/png` / `image/webp` / `image/avif`，扩展名与 MIME 同源校验 |
| 大小限制 | `memoryStorage` + multer `limits.fileSize`（默认 10MB，`MEDIA_MAX_FILE_SIZE` 可配）；超限 413 |
| 魔数验证 | 落盘前校验文件头（JPEG `FF D8 FF` / PNG 8 字节签名 / `RIFF…WEBP` / `ftyp`+`avif`），伪造 MIME → 400 且不入库不落盘 |
| 文件名 | 一律服务端 UUID + 白名单扩展名，**永不使用客户端原始文件名**；原始名仅清洗（basename、去控制字符、非法字符替换、限长 200）后存 `originalName` 供展示 |
| 防路径注入 | `storageKey` 白名单正则 `^media/\d{4}/\d{2}/<uuid>\.[a-z0-9]{1,8}$` + `resolved-path` 目录包含校验（双保险） |
| 不暴露真实路径 | 响应 DTO 不含任何服务器绝对路径；`storageKey` 是对象键；静态路由仅暴露 `/uploads/media/**` |
| 删除引用保护 | 删除前统计 `ProductImage` 引用（`url` 精确匹配 + `url endsWith /<filename>` 双匹配，兼容未来基地址变化）→ 被引用返回 400 `Media asset is in use.`，不删库行不删文件 |
| 越权/穿越测试 | 单测覆盖 5 类非法 `storageKey`（含 `../` 穿越、非法 UUID、非法命名空间）全部拒绝 |

---

## F Tests

### 后端（`bailing-backend`）

| 套件 | 数量 | 结果 |
| --- | --- | --- |
| `test/media-cms.spec.ts`（单元：文件校验 / 尺寸解析 / LocalProvider / MediaService CRUD + 引用检查） | 20 | ✅ |
| `test/media-cms.e2e-spec.ts`（JWT 矩阵 / 上传 / 列表筛选 / 详情 / 引用检查 / 删除） | 11 | ✅ |
| 全量 `npx jest`（9 个套件） | **113** | ✅ 全过 |
| `npm run lint` / `npx tsc --noEmit` / `npm run build` | — | ✅ 全绿 |
| `prisma migrate diff` 漂移检查 | — | ✅ 输出为空 |

任务书要求的测试项覆盖对照：

- **Media CRUD**：list（分页/关键词/分类）、findById（200/404）、remove（200/404）✅
- **Upload**：真 PNG 201 + 落库 + 磁盘 + 静态可读；缺 file 字段 400 ✅
- **Delete**：未被引用 200（库行 + 文件均删）；重复删除 404 ✅
- **JWT Protection**：四端点无令牌 401；伪造令牌 401 ✅
- **File Validation**：非法 MIME 400、伪造 MIME（文本声明 png）400、超 10MB 413 ✅
- **Reference Check**：被 `ProductImage` 引用 → 400 `Media asset is in use.`，且库行与文件未被删除 ✅

### Admin（`bailing-admin`）

`npx tsc --noEmit` ✅ / `npm run lint` ✅ / `NODE_OPTIONS= npm run build` ✅（`/media` 路由已入包）

---

## G 浏览器全流程验证（真实 UI）

脚本：`docs/phase-4.3-browser-flow.sh`（playwright-cli，单会话）
专用测试管理员：`pw-media@bailingwooden.test`（不触碰真实账号）

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | 登录进入 `/dashboard` | ✅ PASS |
| 2 | 进入 `/media` 渲染 | ✅ PASS |
| 3 | **拖拽上传**（`drop` 真实 drop 事件，640×480 PNG） | ✅ PASS（出现卡片） |
| 4 | 画廊卡片：类型 PNG / 尺寸 640×480 / **缩略图真实解码加载**（naturalWidth=640） | ✅ PASS |
| 5 | 截图留档 | ✅ `docs/screenshots/phase-4.3-media-library.png` |
| 6 | 预览弹窗打开（含存储键元数据）→ 关闭 | ✅ PASS |
| 7 | 两步确认删除 → 卡片消失 | ✅ PASS |
| 8 | 媒体计数归零 | ✅ PASS |

排障要点（已在 DEVELOPMENT-LOG 记录）：测试初版用 24 字节 PNG（仅签名 + IHDR，缺 CRC/IEND），
curl 返回 200 但 Chromium 解码失败触发 `onerror`，一度误判为「后端静态资源不可达」；
换成 zlib + CRC32 生成的完整 PNG 后一切正常。**结论：服务端、静态路由、响应头均正确。**

---

## H 腾讯云 COS / CDN 未来接入方案

当前实现已将切换成本压到最低——**只改 Provider 与两个环境变量，业务代码与数据库零改动**。

### 接入步骤

1. **依赖**：`npm i cos-nodejs-sdk-v5`
2. **环境变量**（写入 `.env`，生产由部署平台注入）
   - `STORAGE_PROVIDER=TENCENT_COS`
   - `COS_SECRET_ID` / `COS_SECRET_KEY`（或使用 CAM 子账号 / 临时密钥 STS，禁止主账号密钥）
   - `COS_BUCKET` / `COS_REGION`
   - `COS_CDN_DOMAIN`（可选，如 `https://cdn.bailingwooden.com`；配置后 `getUrl` 返回 CDN 域名）
   - `UPLOADS_BASE_URL` 保留给 Local 实现，不再影响 COS 路径
3. **实现 `TencentCosStorageProvider`**（`src/modules/media/storage/cos-storage.provider.ts` 已有占位与注释骨架）
   - `provider = MediaProvider.TENCENT_COS`
   - `upload()`：`cos.putObject({ Bucket, Region, Key: storageKey, Body: buffer, ContentType })` → 返回 `{ storageKey, filename, url: getUrl(storageKey) }`
   - `delete()`：`cos.deleteObject`（不存在视为成功）
   - `getUrl()`：配置了 `COS_CDN_DOMAIN` 则返回 `${CDN}/${storageKey}`，否则返回 COS 默认域名
   - `exists()`：`cos.headObject`
4. **在 `media.module.ts` 工厂中启用**（当前对 `TENCENT_COS` 抛「未实现」指引，避免半成品被误用）
5. **存量资产搬迁**：写一次性脚本遍历 `media_assets`，将 `provider=LOCAL` 的文件从 `MEDIA_UPLOAD_DIR` 上传到 COS，
   更新 `storageKey`/`url`/`provider`；校验通过后清理本地文件。搬迁期间可双读（旧 URL 仍可访问）。
6. **CDN 加速与缓存**：CDN 回源 COS；`storageKey` 含 UUID，天然可长缓存（`Cache-Control: max-age=31536000, immutable`）；
   如需图片处理（缩放/WebP），接 CDN 图片处理或 COS 数据处理，在 `getUrl` 中拼接处理参数即可。

### 与现有数据的关系

- `storageKey` 命名空间 `media/<年>/<月>/<uuid>.<ext>` 与具体存储服务无关，可原样作为 COS `Key`。
- 删除引用检查使用「`url` 精确匹配 + `url` 以 `/<filename>` 结尾」双匹配——**切换到 CDN 域名后依然能命中历史引用**，这是当初选择双匹配的原因。

### 可选演进：ProductImage 迁移到 mediaId

评估结论（本阶段不改，风险高）：Phase 4.2 的 `ProductImage.url` 是纯字符串，改为 `mediaId` 外键需要
① 数据回填（按 url 反查 media 资产）② 公开站与 CMS 全部读取路径改造 ③ 删除逻辑改级联。
建议在 COS 接入稳定后单独立项，届时可保留 `url` 作为冗余快照以兼容缓存与 SEO。

---

## I Git Commit 信息

### bailing-backend（分支 `261014` → ff 合入 `dev`）

```
feat(media): Phase 4.3 媒体资源库（Storage Adapter + Media CMS API）

- 数据库：演扩 Phase 1 预留 media_assets 模型（filename/originalName/storageKey/
  url/mimeType/size/width/height/altText/provider/category/createdBy），
  手写迁移 20261014151500_add_media_assets，migrate diff 零漂移
- Storage Adapter：StorageProvider 接口 + LocalStorageProvider 实现 +
  TencentCosStorageProvider 预留占位；STORAGE_PROVIDER 环境变量切换
- Media CMS API（/api/v1/cms/media，全部 JwtAuthGuard）：
  POST /upload（multipart，内存接收，MIME+魔数+10MB 校验，UUID 存储键）
  GET /（分页 + keyword + category）、GET /:id、DELETE /:id（引用检查 → 400）
- 修复 storageKey 逻辑命名空间与物理路径双前缀导致的静态 404
- 接线：configuration / app.setup（/uploads/media 静态挂载）/ cms.module /
  http-exception.filter（MulterError 兜底）/ .env.example
- 测试：media 单测 20 + e2e 11；全量 113/113；lint / typecheck / build 全绿
- 文档：API-CONVENTIONS §11、DEVELOPMENT-LOG §10、PHASE-4.3-FINAL-REPORT、
  浏览器流程脚本与截图
```

### bailing-admin（分支 `261014` → ff 合入 `dev`）

```
feat(media): Phase 4.3 Admin 媒体资源库页面

- /media：画廊网格（缩略图/文件名/类型/大小/尺寸/上传时间/操作）、
  拖拽上传（客户端预校验 + Server Action 转发 multipart）、
  两步确认删除、关键词搜索、图片预览弹窗（含存储键等元数据）
- src/lib/media.ts（API 层 + 格式化 + 删除失败友好映射）、media/actions.ts
- 侧边栏启用 Media 入口；middleware 增加 /media/:path* 保护
- 质量门：tsc / lint / build 全绿；浏览器全流程（登录→上传→预览→删除）全 PASS
```

> 推送说明：`github.com` 在当前网络环境不可达（代理 502 / 直连 TLS 失败），
> 提交留存本地分支，网络恢复后按 `261014 → dev` 推送（见任务 #24）。

---

## 交付物

| 类型 | 路径 |
| --- | --- |
| 迁移 | `bailing-backend/prisma/migrations/20261014151500_add_media_assets/` |
| 后端模块 | `bailing-backend/src/modules/media/**` |
| 后端测试 | `bailing-backend/test/media-cms.spec.ts`、`test/media-cms.e2e-spec.ts` |
| Admin 页面 | `bailing-admin/src/app/(dashboard)/media/**`、`src/lib/media.ts` |
| 浏览器验证 | `bailing-backend/docs/phase-4.3-browser-flow.sh` |
| 截图 | `bailing-backend/docs/screenshots/phase-4.3-media-library.png` |
| 文档 | `docs/API-CONVENTIONS.md §11`、`docs/DEVELOPMENT-LOG.md §10`、本报告 |

### 运行中的服务（本地 + 局域网）

| 服务 | 本地 | 局域网 |
| --- | --- | --- |
| Admin 后台 | http://localhost:3001 | http://192.168.1.40:3001 |
| 主站 | http://localhost:3000 | http://192.168.1.40:3000 |
| 后端 API | http://127.0.0.1:4000/api/v1 | http://192.168.1.40:4000/api/v1 |

说明：为让局域网设备也能看到图片，`UPLOADS_BASE_URL` 已设为 `http://192.168.1.40:4000`，
`CORS_ORIGINS` 追加了 `192.168.1.40:3000/3001`。若更换网络导致本机 IP 变化，需同步更新这两项并重启后端。
