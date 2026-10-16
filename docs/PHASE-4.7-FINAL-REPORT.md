# Phase 4.7 最终报告 —— 全站 CMS 整合 · 权限完善 · 统一治理

> 仓库：`bailingsg/bailing-backend` · `bailingsg/bailing-admin` · `bailingsg/bailing-ui`（均为私有）
> 执行日期：2026-10-16
> 分支：三仓库均为 `261017`（后端 / 后台自 `261016` 拉出，前台自 `261013` 拉出）
> 本文所有数字均来自本次实跑输出，未使用估算值。

---

## A. 执行摘要

Phase 4.7 的目标是**把 4.1–4.6 已建成的 CMS 能力真正打通并统一治理**：内容状态统一为三态、
公开 API 严格只出已发布内容、前台从演示数据切换到真实 CMS 数据源、
后台补齐站点内容与导航管理界面、权限体系补齐并验证越权防护、SEO 与媒体引用治理收口。

本次交付的核心事实（全部实测）：

| 项目 | 结果 |
| --- | --- |
| 后端单元 / 集成测试 | **293 / 293 通过**（17 个套件） |
| API 链路验证（新增脚本） | **44 / 44 通过**（鉴权 / 越权 / 状态隔离 / DTO 白名单 / 危险 URL / 媒体保护） |
| 浏览器全流程验证（新增脚本） | **28 / 28 通过**（前台 9 页 + 后台保存 + ISR 闭环 + 移动端 375/390/768） |
| 数据库迁移 | 12 项全部应用，`migrate diff` **为空（零漂移）** |
| 三端质量门 | lint / tsc / build **全部通过**（前台 demo 与 api 两种模式均构建通过） |
| Git | 三仓库 `261017` 已推送；**master 未被改动**，无 force push |

**本轮联调实测发现并修复了 4 个真实缺陷**（此前从未被验证覆盖，详见 N 节）：

1. 后台「站点内容」弹窗编辑模式下必填字段被 `disabled`，导致**所有分区编辑都无法保存**（服务端校验拒绝）；
2. 后台「导航管理」弹窗同类缺陷（`location` 字段）；
3. 前台「关于我们」页面分区键前缀不匹配（页面读 `hero`，种子写 `about.hero`），导致 CMS 内容不生效；
4. 后台登录页仍为英文（`Login` / `Email` / `Password`），与「后台统一中文」要求不符。

---

## B. 审计发现（Phase 4.1–4.6 实际状态）

开始 Phase 4.7 前对既有代码、数据库、API、后台、前台与 Git 状态做了逐项审计，关键结论：

**后端**
- 无全局 Guard：权限完全依赖各 Controller 上的 `@RequirePermissions` 声明（已确认声明与权限注册表 100% 对齐，41 项在用）。
- 公开 API（factory / quality / applications / contacts / products / categories）已全部按 `PUBLISHED` 过滤且使用 DTO 白名单映射。
- **博客没有公开 API**（只有后台 CMS 接口）——前台博客无法接真实数据。
- 内容状态不统一：`ProductStatus` 已是三态，`PostStatus` 与 `ContentStatus` 只有两态，缺少「归档」语义。
- 无站点级结构化内容（首页 / 关于我们 / 联系页文案全部硬编码在前端）。
- 媒体 `countReferences` 未覆盖站点内容引用（新增模型后需同步扩展，否则出现删除漏保护）。

**后台**
- 已有产品 / 分类 / 媒体 / 博客 / 工厂 / 质量 / 应用 / 账号 / 角色 / 询盘分配等中文界面。
- 缺站点内容与导航管理界面；内容列表徽章只有两态。

**前台**
- 全部页面消费仓库内演示数据（`demo-data.ts`），仅产品模块具备 `api` 模式开关。
- 导航 / 页脚来自 `config/site.ts` 硬编码；博客正文为结构化区块（无 CMS HTML 渲染路径）。
- sitemap 已覆盖静态路由 + 产品 / 文章详情，无遗漏（本次未新增详情路由，故无需扩展）。

**数据库 / Git**
- 迁移 10 项全部应用，无漂移；`site_sections` 等新表尚不存在。
- Git：后端 `261016`（本地）→ `origin/dev` 停留在 Phase 4.4；后台 `261016` 未推送；前台仓库**仅有 Phase 1 一次提交**，Phase 2 起的前端成果一直未入库（见 M 节）。

---

## C. 代码变更清单

### C.1 后端（bailing-backend）

**数据库与种子**
- `prisma/schema.prisma`：`PostStatus` / `ContentStatus` 增 `ARCHIVED`；新增 `SitePage` / `NavLocation` 枚举、
  `SiteSection` 与 `NavItem` 模型、`MediaAsset.siteSectionMedia` 反向关系。
- `prisma/migrations/20261016090000_unify_content_status_add_site_content/`：两枚举 ADD VALUE + 两新表 + 索引 + 外键。
- `prisma/migrations/20261016100000_site_section_eyebrow_items/`：`site_sections` 补 `eyebrow` / `items` 列。
- `prisma/seed-site-content.ts`（新增）：逐字迁移前台既有真实文案 —— HOME 5 分区、ABOUT 6 分区、导航 18 项（页眉 8 + 页脚 10），幂等 upsert。
- `prisma/seed-rbac.ts`：`CONTENT_EDITOR` 预设追加 `site.read/create/update`。

**权限**
- `src/modules/rbac/permission.registry.ts`：新增 `site` / `nav` 两模块 8 项权限，总权限 50 项。

**站点 CMS（新增 `src/modules/cms/site/`）**
- `site-url.ts`：`normalizeSiteUrl()` —— URL 安全单一切片（仅站内相对路径，禁 `//` 与 `/\`；https / mailto / tel；拒 `javascript:` / `data:` / `http` / 裸域名；先剥离不可见字符再判协议）。
- `dto/site-section.dto.ts` / `dto/nav-item.dto.ts`：分页参数命名 `pageNum/pageSize`（避免与 `page` 页面过滤器冲突）。
- `entities/site.entity.ts`：读出侧白名单 `parseSiteSectionItems()`（超长 / 超 8 项 / 未知字段全部降级）、`parseSiteSectionStats()`（超 6 项截断）。
- `site-sections.service.ts`：CRUD + `assertPublishable()` 发布完整性 + `publishedAt` 流转 + 审计日志。
- `nav-items.service.ts` / `site.controller.ts` / `site.module.ts`。

**公开只读 API（`src/modules/public/`）**
- `public-blog.service.ts` + `public-blog.controller.ts`：`GET /public/blog`、`/public/blog/categories`（**先于 `:slug` 声明**）、`/public/blog/:slug`。
- `public-site.service.ts` + `public-site.controller.ts`：`GET /public/site/:page`、`/public/site/:page/:sectionKey`、`/public/navigation`。
- `entities/public.entity.ts`：博客映射 + `estimateReadingMinutes()`（中文按字 / 英文按词，200 字/分钟）。
- `entities/public-site.entity.ts`：站点分区白名单映射（不透出 `id/status/createdBy/sortOrder/mediaId`）。

**媒体**
- `media/media.service.ts`：`countReferences` 扩展 `siteSection`。

### C.2 后台（bailing-admin）
- 新增 `/site-content`（列表 + 筛选 + 新建 / 编辑弹窗 + 媒体选择器 + 两步删除 + 状态流转）
  与 `/navigation`（页眉 / 页脚分组 + 弹窗 + 启用停用 + 两步删除）。
- `src/lib/rbac.ts`：站点内容 / 导航全套类型与 API 函数；`CONTENT_STATUSES` 三态与中文标签。
- 侧边栏新增两个入口（按 `site.read` / `nav.read` 显隐）。
- 内容三态徽章适配（blog / factory / quality / applications）。
- 修复：弹窗 disabled 字段改隐藏域补交；登录页中文化。

### C.3 前台（bailing-ui）
- `src/lib/cms-api.ts`（新增）：统一 fetch 层（`apiGet` / `isApiSource` / `isNotFound` / `qs`，ISR 300s）。
- `src/lib/site/`、`src/lib/quality/`、`src/lib/contacts/`（新增模块）；`lib/blog`、`lib/products`、`lib/factory`、`lib/applications` 接入 api 模式。
- `src/components/cms/site-section-block.tsx`（新增）：SiteSection 定式字段渲染器。
- `app/layout.tsx` 服务端并行取导航 → Navbar / Footer / MobileMenu（外链补 `rel="noopener noreferrer"`）。
- 首页 / 关于我们 / 联系页按 `sectionKey` 槽位消费 CMS 分区（未发布槽位自动回退演示版式）。
- 博客详情优先渲染 CMS `contentHtml` + 新增 `.blog-prose` 排版样式（与后端白名单标签一一对应）。
- 工厂页接 OVERVIEW 正文与图库 / 展会照片；质量页接已发布认证与报告；应用场景接公开接口。

---

## D. 数据库状态

```
12 migrations found in prisma/migrations
Database schema is up to date!

$ prisma migrate diff --from-schema-datasource ... --to-schema-datamodel ...
-- This is an empty migration.        ← 零漂移
```

本次新增两迁移的 SQL 要点：
- `ALTER TYPE "PostStatus" ADD VALUE 'ARCHIVED'`、`ALTER TYPE "ContentStatus" ADD VALUE 'ARCHIVED'`
  （PostgreSQL 17 允许在事务内 ADD VALUE，只要同事务不使用新值）；
- `CREATE TABLE site_sections` / `nav_items` + 唯一约束 `(page, sectionKey)` + 索引 + 外键（`mediaId` 为 `SET NULL`）；
- 第二次迁移补 `eyebrow TEXT` / `items JSONB`。

**数据现状（实测计数）**

| 表 | 行数 | 说明 |
| --- | --- | --- |
| `site_sections` | 11 | HOME 5（hero / capabilities / products / applications / cta）+ ABOUT 6（hero / profile / story / philosophy / why / solutions），全部 PUBLISHED |
| `nav_items` | 18 | 页眉 8 + 页脚 10，全部启用 |
| `products` | 5 | Phase 4.2 起的真实产品记录 |
| `media_assets` | 2 | 媒体库既有素材 |
| `blog_posts` | 0 | 无已录入文章（验证用临时文章已删除） |
| `factory_sections` / `quality_records` / `applications` | 0 | 业务方尚未录入（前台如实显示"待补充"） |

**诚实说明（迁移纪律）**：首次手写 `nav_items` 迁移时漏写 `isActive` / `openInNewTab` 的 `NOT NULL`，
被 `migrate diff` 检出（`ALTER TABLE nav_items ALTER COLUMN "isActive" SET NOT NULL`）。
由于迁移文件已应用（checksum 不可回退，且 enum 值无法回退），改用 `psql` 直接执行对齐语句，
随后复验 diff 为空。该处理已在此显式记录，未通过修改历史迁移文件掩盖。

---

## E. 权限与 RBAC

- 权限注册表 **50 项**，模块含 `site` / `nav`（本轮新增 8 项）。
- 内置角色：`SUPER_ADMIN`（不落 `role_permissions`，代码恒等于全集）、`CONTENT_EDITOR`（23 项）、`SALES`（5 项）。
- `CONTENT_EDITOR` 新增 `site.read/create/update`（**不含** `site.delete`，**不含** `nav.*`）。

**权限增量落库说明**：RBAC 种子的既有语义是「角色已存在权限绑定时不覆盖（避免覆盖管理员手工调整）」，
因此代码预设新增的 `site.*` 不会自动写入已存在的库。本次按**运营路径**（等价于后台「角色与权限」页面操作）
通过 `PUT /cms/roles/:id/permissions` 为该角色补齐，实测结果：`permissionCount = 23 / 50`。

**越权与安全验证（实测，全部通过）**
- 未认证访问 CMS → 401；
- `CONTENT_EDITOR`：`site.read` 放行（200）；`accounts.read` / `site.delete` / `nav.create` / `blog.delete` / `roles.read` 全部 **403**；
- 未授予 `nav.*` 的编辑者无法创建导航项；
- 危险 URL 一律 400：`javascript:alert(1)`、`http://evil.example.com`、`//evil.example.com`；合法 `https://` 外链放行；
- 空内容分区发布被拒 403（发布完整性）。

---

## F. 公开 API 与内容状态隔离

| 接口 | 行为 |
| --- | --- |
| `GET /public/blog` | 仅 PUBLISHED；`pageSize` 超限（>24）→ 400 |
| `GET /public/blog/:slug` | 草稿 / 归档 / 不存在统一 **404**（不泄漏存在性） |
| `GET /public/blog/categories` | 只统计 PUBLISHED |
| `GET /public/site/:page` | 仅 PUBLISHED 分区 |
| `GET /public/site/:page/:sectionKey` | 草稿分区 404 |
| `GET /public/navigation?location=` | 仅 `isActive=true` |

实测隔离用例：创建 DRAFT 文章 → 公开详情 404 且不在列表；发布 → 公开详情 200；
归档（ARCHIVED）→ 公开详情恢复 404；草稿分区 → 公开详情 404 且不在列表；停用导航项 → 不在公开导航，启用后出现。

**DTO 白名单实测**：公开响应不含 `storageKey` / `createdBy` / `provider` / `status` / `sortOrder` / `authorId` / `categoryId` / `ogTitle`。
**富文本净化实测**：写入 `<script>alert(1)</script>` 后，后台与公开响应中的正文均为 `<p>hello</p><p>world</p>`（标签被剥离）。

---

## G. 站点结构化内容 CMS（非页面构建器）

`SiteSection` 是**定式字段**（`eyebrow / title / subtitle / body / media / ctaLabel / ctaUrl / items / stats`），
以 `page + sectionKey` 语义定位（如 `home.hero`、`about.why`），不含自由布局或区块拖拽能力。

- 写入侧：DTO 校验（长度 / 数组上限 / URL 安全）+ 服务端发布完整性校验；
- 读出侧：`items` 与 `stats` 逐项白名单降级（未知字段丢弃、超限截断），公开接口再映射为展示 DTO；
- 前台：`SiteSectionContent` / `SiteSectionBlock` 为唯一渲染契约；`items` 渲染为卡片（带可选 `Learn more`），
  `stats` 渲染为指标行；站内相对路径走 `next/link`，外链补 `rel`。
- 覆盖页面：HOME（5 槽位）、ABOUT（6 槽位）、CONTACT（hero 槽位，当前无数据时回退演示版式）。

---

## H. 导航 / Footer 治理

- 导航改为 CMS 数据驱动（`NavItem`），页眉 / 页脚分区管理，`isActive` 控制前台可见性，`openInNewTab` 控制新窗口。
- URL 一律经 `normalizeSiteUrl()` 校验（站内相对路径或 https / mailto / tel），拒绝协议相对与危险协议。
- 前台在 `app/layout.tsx` 服务端并行取两组导航并注入 Navbar / Footer / MobileMenu（客户端组件）；
  外链渲染 `target="_blank"` + `rel="noopener noreferrer"`。
- 页脚改版为「品牌 + CMS Sitemap 双列导航 + 联系信息」，保留证书 / 社交占位。

---

## I. SEO 治理

- 博客详情：动态 metadata（title / description / canonical / article OG）+ `Article` JSON-LD（禁止 Product schema）。
- 全站 metadata 由 `buildMetadata()` 统一（绝对标题、canonical、OG/Twitter）。
- `sitemap.xml`：静态路由（`config/site.ts` 的 `siteRoutes`）+ 产品详情 + 文章详情（api 模式从公开接口翻页收集）。
- `robots.txt` 与 `siteConfig.allowIndexing` 联动（当前为禁止收录的框架阶段），始终输出 sitemap 地址。
- 本次未新增详情路由（factory / quality / applications 无 `[slug]` 页面），因此 sitemap 无需扩展 —— 审计项已确认。

---

## J. 媒体库与删除保护

- `countReferences` 覆盖：产品图片、博客封面、工厂封面 / 图集 / 展会照片、质量证书、应用场景封面、**站点分区媒体**。
- 实测：上传验证素材 → 挂到 `home.hero` → 删除返回 **400**（被引用）；解除引用后删除 **200**。
- 公开媒体引用只暴露 `url / altText / width / height / mimeType / isDocument`，不含 `storageKey` 与磁盘路径。
- COS / CDN 仍只预留（`StorageProvider` 抽象 + `STORAGE_PROVIDER=LOCAL`），**未做迁移**。

---

## K. 前台接线（双数据源）

统一开关 `NEXT_PUBLIC_CMS_SOURCE`（默认 `demo`）：

| 模式 | 行为 |
| --- | --- |
| `demo`（默认） | 使用仓库内演示数据 / 版式，离线可构建；站点分区返回空数组、页面走既有版式 |
| `api` | 调用后端公开只读接口；后端不可用**如实抛错**（error 边界接管），**绝不静默回退演示数据** |

- 旧开关 `NEXT_PUBLIC_PRODUCTS_SOURCE` 保留兼容（任一为 `api` 即走接口），产品模块统一到同一 fetch 层。
- ISR 300s：内容型 fetch 重验证窗口 5 分钟；实测后台保存后**前台首页在 60 秒内自动更新**（无需重启）。
- 前台不再直接 `fetch`：所有取数经各模块 repository。

---

## L. 测试与验证结果

### L.1 后端测试套件
```
Test Suites: 17 passed, 17 total
Tests:       293 passed, 293 total
Time:        56.6 s
```
本轮新增：`rbac.spec.ts`(19) / `public-api-status.spec.ts`(8) / `site-cms.spec.ts`(13)；
`media-cms.spec.ts` 补 `siteSection` 引用用例；`lead-distribution.e2e-spec.ts` 清理未用变量。

### L.2 API 链路验证（`docs/phase-4.7-api-verify.py`，44/44 通过）
覆盖：未认证 401 / 管理员登录 / 草稿与归档隔离 / 公开 DTO 白名单 / 富文本净化 /
分页上限 / CMS 写入 → 公开读取 / 危险协议 400 / 发布完整性 403 / 导航启用过滤 /
媒体删除保护 / CONTENT_EDITOR 权限增量与越权 403（5 类）。

### L.3 浏览器全流程（`docs/phase-4.7-browser-flow.mjs`，28/28 通过）

| 组 | 内容 | 结果 |
| --- | --- | --- |
| A1–A9 | 首页 / 关于 / 工厂 / 质量 / 应用 / 博客列表 / 博客详情 / 产品 / 联系 全部 200 且含 CMS 或接口内容 | 9/9 |
| A7 | 正文 `contentHtml` 渲染（h2 + ul + blockquote）、`.blog-prose` 生效、XSS 载荷未进入页面 | 4/4 |
| A10 | 375 / 390 / 768 三种视口 × 3 个页面，`scrollWidth ≤ clientWidth`（无横向溢出） | 9/9 |
| B1–B4 | 后台登录、站点内容列表（中文 + 分区键 + 状态徽章）、**编辑保存并回显**、导航管理页 | 4/4 |
| C1 | 后台保存 → 前台首页在 ISR 窗口内自动更新（等待 60s） | 1/1 |
| D1 | 首页 hero 标题还原 | 1/1 |
| A11 | 全程无 console error | 1/1 |

截图留档：`docs/screenshots/phase-4.7/`（14 张，含桌面 / 移动端 / 后台页面 / 闭环后首页）。

### L.4 质量门
- 后端：`eslint` 通过、`nest build` 通过、`jest` 293/293。
- 后台：`eslint` 通过、`tsc --noEmit` 通过、`next build` 通过（新增路由 `/site-content`、`/navigation`）。
- 前台：`eslint` 通过、`tsc --noEmit` 通过、`next build` **demo 与 api 两种模式均通过**
  （api 模式构建期即从后端公开接口取数并预渲染：验证期间 `/blog/[slug]` 正确产出临时验证文章页；
  验证完成后已删除该临时文章并**清空 `.next/cache` 重新构建**，博客列表回到空态占位，与数据库现状一致）。

---

## M. Git 状态与分支策略

| 仓库 | 基线 | 新分支 | 提交 | 远程 |
| --- | --- | --- | --- | --- |
| bailing-backend | `261016` (bd8f0be) | `261017` | `aff34d1` feat(cms) → `e81304a` docs（报告 + 验证脚本 + 截图） | 已推送 |
| bailing-admin | `261016` (121a7ad) | `261017` | `eb0182e` feat(admin) | 已推送 |
| bailing-ui | `261013` (eb4f3b9) | `261017` | `0787612` feat(ui) | 已推送 |

- **master 未改动**；全程无 `force push`、无历史重写。
- 分支拓扑现状（诚实说明）：`origin/dev` 仍停留在较早基线（后端 / 后台 Phase 4.4，前台仅初始化提交）；
  既有工作一直以日期分支递进（`261013 → 261014 → 261016 → 261017`）。本轮沿用该既定方式，未擅自推进 `dev`。
- **前台仓库重要说明**：`bailing-ui` 此前仅有 Phase 1 一次提交（`eb4f3b9`），Phase 2 起的前端成果
  （全部页面 / 组件 / 数据层 / 设计系统）一直停留在工作区未入库。本次以 `261017` 一次性完整入库，
  提交信息中已显式说明该背景，避免后续读者误判历史。

---

## N. 遗留问题、风险与后续建议

**本轮修复的缺陷（均为实测发现，非推测）**
1. 站点内容弹窗：编辑模式下「所属页面 / 分区键」`disabled` 控件不进 `FormData` → **所有分区编辑保存均失败**（已改隐藏域补交）。
2. 导航弹窗：`location` 同类缺陷（已修复）。
3. 关于我们页：分区键前缀不匹配（页面读 `hero`，种子写 `about.hero`）→ CMS 内容不生效（已修正为 `about.*`）。
4. 后台登录页残留英文（`Login` / `Email` / `Password` / `Signing in…`）→ 已中文化并映射 401 文案。

**已知限制（如实记录，未隐藏）**
1. `CONTENT_EDITOR` 的 `site.*` 授权需按运营路径补齐（种子不覆盖既有角色绑定）——建议后续在「角色与权限」页面
   增加「新增权限未授予任何角色」的提示，减少人工遗漏。
2. 前台内容更新依赖 ISR 300s 窗口（实测 60s 内生效）；如需「发布即刷新」，
   建议后续增加按需 revalidate 的 Webhook（后台发布 → 调用前台 revalidate 路由），本轮未实现。
3. 工厂 / 质量 / 应用场景三模块的**页面框架文案**仍为演示版式，仅在其有已发布 CMS 数据时展示真实内容
   （图库 / 认证记录 / 场景列表）；当前库中这三模块数据为 0，前台如实显示"待补充"，未使用任何虚构内容。
4. 前台 `getProductSlugs` / `getBlogSlugs` 在 api 模式下失败会**抛错**（构建期大声失败而非静默产出缺内容的站点）；
   若生产环境希望构建容忍后端短时不可用，需另行设计（本轮按"诚实优先"处理）。
5. 历史遗留的 e2e 测试账号（`e2e-*@bailingwooden.test`，均 `isActive=false`）仍在库中，未清理（非本轮范围）。
6. COS / CDN 仍只预留，未迁移（符合任务要求）。
7. **构建缓存注意（本轮实测发现）**：Next.js 的 `.next/cache`（fetch 缓存，实测 142 MB）会**跨构建复用**
   公开接口响应；在删除 / 修改 CMS 数据后重新构建前必须清空该目录，否则会产出与数据库不一致的静态页
   （本轮删除验证文章后首次重建即复现——`/blog/[slug]` 仍预渲染已删除的文章；清空 `.next/cache` 重建后修正）。

**建议的下一阶段（Phase 4.8 候选）**
- 按需 revalidate Webhook（后台发布 → 前台即时刷新）；
- 权限增量提示与「权限覆盖率」审计页；
- 工厂 / 质量 / 应用场景真实素材与认证录入（业务方提供后即可上线，无需改代码）；
- 站点内容分区的前台可视化预览（后台弹窗内预览）。
