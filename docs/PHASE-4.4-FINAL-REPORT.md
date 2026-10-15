# Phase 4.4 Final Report

**阶段**：Phase 4.4 — Blog CMS + SEO 内容管理系统
**日期**：2026-10-15
**分支**：`261014`（自 `dev` 拉取，完成后 ff 合入 `dev`）
**仓库**：`bailing-backend`、`bailing-admin`

---

## A 状态

| 项 | 结果 |
| --- | --- |
| 数据模型（BlogCategory / BlogTag / BlogPostTag 新增，BlogPost 演扩） | ✅ 演扩 Phase 1 预留模型，零漂移 |
| 迁移 | ✅ `20261014171544_add_blog_cms`，手写 SQL，`migrate status` 正常，diff 输出为空 |
| Blog CMS API（文章 / 分类 / 标签 CRUD + SEO） | ✅ 全部 `JwtAuthGuard` |
| Admin 中文后台（文章列表 / 新建 / 编辑 / 分类管理 / 标签管理） | ✅ 已上线（生产构建） |
| 富文本编辑器（标题/段落/列表/链接/图片/代码块） | ✅ 图片经 Media Library 选择，**不自行存储** |
| 富文本 XSS 净化（自研白名单，无第三方依赖） | ✅ 全链路 + XSS 矩阵测试 |
| 媒体引用检查扩展到博客封面 | ✅ 被引用媒体删除返回 400 + 中文提示 |
| 未来权限兼容（RBAC 预留，不写死管理员） | ✅ 控制器级 Guard，未硬编码角色 |
| 测试与质量门 | ✅ lint / typecheck / build / **176/176** jest / 浏览器 **38/38** PASS |
| 破坏 Phase 4.1 / 4.2 / 4.3 既有功能 | ❌ 无（回归全绿） |
| 服务运行状态 | ✅ backend 4000 / admin 3001 / ui 3000，**本地与局域网（192.168.1.40）均可访问** |

---

## B Database

**决策：演扩 Phase 1 预留模型，不破坏既有数据。**

Phase 1 的初始迁移已预留 `BlogPost` 模型与 `PostStatus` 枚举（注释标注「内容营销 / SEO，Phase 2+ 完善」），
但**未包含 Category / Tag / PostTag**。因此本阶段策略为：

- `BlogPost`：**演扩**（新增 10 列，保留原 `coverImageUrl`）
- `BlogCategory` / `BlogTag` / `BlogPostTag`：**新增模型**

迁移文件：`prisma/migrations/20261014171544_add_blog_cms/migration.sql`（手写 SQL，92 行）

### 表结构

| 表 | 列 |
| --- | --- |
| `blog_categories` | id / name / slug(unique) / description? / sortOrder(default 0) / isActive(default true) / createdAt / updatedAt<br>索引：`isActive`、`sortOrder` |
| `blog_tags` | id / name / slug(unique) / createdAt |
| `blog_posts` | id / title / slug(unique) / excerpt? / content(Text) / coverImageUrl? / **coverMediaId?** / **categoryId?** / status(枚举，默认 DRAFT) / **featured**(默认 false) / publishedAt? / authorId? / **seoTitle?** / **seoDescription?** / **seoKeywords?** / **canonicalUrl?** / **ogTitle?** / **ogDescription?** / **ogImage?** / **twitterTitle?** / **twitterDescription?** / createdAt / updatedAt<br>索引：`status`、`publishedAt`、`categoryId`、`featured`、`coverMediaId` |
| `blog_post_tags` | postId + tagId（复合主键）/ createdAt<br>索引：`tagId`；双向 `onDelete: Cascade` |

**加粗**为本次新增列。

### 关键设计取舍

| 取舍 | 理由 |
| --- | --- |
| `coverMediaId`（关联）与 `coverImageUrl`（快照）双保留 | `coverMediaId` 为 Phase 4.3 媒体库关联、删除时可做引用保护；`coverImageUrl` 保留以兼容历史外链 / COS CDN 地址，且公开站可直接渲染无需二次查询 |
| 显式 join 模型 `BlogPostTag` | 便于未来加排序 / 权重字段，避免隐式多对多的迁移僵局 |
| 分类 / 标签删除用 `onDelete: SetNull`（文章侧）、`Cascade`（关联表侧） | 删分类不删文章（文章落为「未分类」）；删标签自动解绑 |
| OG / Twitter 字段本阶段仅存储 + 透出 | 任务书要求「预留」，不接入第三方校验 |

### 迁移验证

```
npx prisma migrate status
  → 6 migrations found / Database schema is up to date!

npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
                        --to-schema-datamodel  prisma/schema.prisma --script
  → -- This is an empty migration.        （零漂移）
```

> 注：`prisma generate` 前需先 `taskkill` 占用 Prisma engine DLL 的后端进程（Windows 文件锁）。

---

## C Backend

### 目录（`src/modules/cms/blog/`）

```
blog.module.ts
blog-posts.controller.ts          blog-posts.service.ts
blog-categories.controller.ts     blog-categories.service.ts
blog-tags.controller.ts           blog-tags.service.ts
entities/blog.entity.ts           （DTO + mapper）
dto/blog-post.dto.ts              （Create / Update；Update 允许 null 表示清空）
dto/list-blog-posts-query.dto.ts  （page/limit/keyword/status/categoryId/tagId/featured）
dto/blog-category.dto.ts
dto/blog-tag.dto.ts
rich-text.sanitizer.ts            （自研白名单净化器，无第三方依赖）
```

### 接口（前缀 `/api/v1/cms/blog`，**控制器级 `JwtAuthGuard`**）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/posts` | 分页 + `keyword` / `status` / `categoryId` / `tagId` / `featured` 筛选 |
| GET | `/posts/:id` | 文章详情（含 content / SEO / OG / Twitter / tags / coverMedia） |
| POST | `/posts` | 创建（正文经 sanitize；发布时自动回填 `publishedAt`） |
| PATCH | `/posts/:id` | 更新（支持显式 `null` 清空可选字段） |
| DELETE | `/posts/:id` | 删除（级联移除标签关联） |
| GET / POST | `/categories` | 分类列表（含 `postCount`，按 sortOrder 升序）/ 创建 |
| PATCH / DELETE | `/categories/:id` | 更新 / 删除（分类下有文章返回 400） |
| GET / POST | `/tags` | 标签列表（含引用计数，按名称升序）/ 创建 |
| PATCH / DELETE | `/tags/:id` | 更新 / 删除（级联解绑） |

### 富文本净化器（`rich-text.sanitizer.ts`）

**自研白名单净化器，不引入第三方依赖**（项目无 sanitizer 库，避免新增供应链面）。

- **标签白名单**：h1–h6 / p / br / hr / strong / em / u / s / blockquote / ul / ol / li / a / img / code / pre / span / div / table 系列
- **逐标签属性白名单**：`a` 仅 `href/title/target/rel`；`img` 仅 `src/alt/title/width/height`；其余标签仅保留 `class`（且清空脚本类）
- **URL 协议白名单**：仅 `http` / `https` / `mailto` / `tel` / 相对路径；`javascript:` / `data:`（非图片）/ `vbscript:` 一律丢弃
- **危险标签连同内容一起删除**：`script` / `style` / `iframe` / `object` / `embed` / `form` / `input` 等
- **实体解码 + 控制字符过滤**：防 `java&#115;cript:` 类绕过；控制字符用 charCode 判定（规避 `no-control-regex` lint）

**三处实测修复的边界缺陷**：

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| 文档外壳被整体丢弃 | `<html><body>…正文…</body></html>`（Word 粘贴场景）连正文一起消失 | `html`/`head`/`body` 改为「丢标签、保留正文」 |
| void 元素吞掉后续内容 | `<meta>` 后所有正文消失 | void 元素（meta/link/base/br/hr/img…）自闭合处理，不再向后找闭合标签 |
| `no-control-regex` lint 报错 | 控制字符正则被 ESLint 拦截 | 改用 `charCodeAt` 判定 |

### 接线改动

| 文件 | 改动 |
| --- | --- |
| `src/modules/cms/cms.module.ts` | `imports: [PrismaModule, ProductsModule, MediaModule, BlogModule]` |
| `src/modules/media/media.service.ts` | `countReferences` 扩展：同时统计 `ProductImage` 与 `BlogPost` 封面引用（URL 精确匹配 + `endsWith(/filename)` 双匹配） |
| `src/common/validators/slug.ts` | **新增**：slug 常量与正则单一来源，产品与博客共用（`product` 侧改为再导出） |
| `src/modules/cms/products/dto/category.dto.ts` | 改为从 `common/validators/slug` 引入，消除重复定义 |

---

## D Admin

### 新增文件

```
src/lib/blog.ts                                   API 层（全部服务端调用）
src/app/(dashboard)/blog/
  actions.ts                                      Server Actions（文章/分类/标签）
  page.tsx                                        文章列表（搜索/状态/分类筛选/分页）
  create/page.tsx                                 新建文章
  [id]/edit/page.tsx                              编辑文章
  categories/page.tsx  categories/category-manager.tsx
  tags/page.tsx        tags/tag-manager.tsx
  post-form.tsx                                   文章表单（新建/编辑共用）
  rich-text-editor.tsx                            富文本编辑器
  media-picker.tsx                                媒体库选择弹窗（封面/插图共用）
  cover-picker.tsx                                封面选择与预览
  blog-nav.tsx                                    二级导航（文章列表/分类/标签）
  delete-post-button.tsx                          两步删除
```

### 功能对照任务书

| 任务书要求 | 实现 |
| --- | --- |
| 菜单「博客管理」（文章列表/分类管理/标签管理） | ✅ 侧边栏 Blog 项启用（原 Coming Soon），`blog-nav` 二级导航 |
| 路由 `/blog`、`/blog/create`、`/blog/[id]/edit` | ✅ 生产构建含 5 条 blog 路由 |
| 列表：封面/标题/分类/状态/发布时间/更新时间/操作 | ✅ 全列 + 封面缩略图 |
| 搜索 / 状态筛选 / 分类筛选 / 分页 | ✅ |
| 富文本：标题/段落/列表/链接/图片/代码块 | ✅ 工具栏含 H2/H3/段落/B/I/U/有序无序列表/引用/代码块/链接/图片/清除格式 |
| **不自行存储图片** | ✅ 图片按钮调 `MediaPickerModal`，只读浏览 `/cms/media`，上传仍走「媒体资源」页 |
| 中文后台 | ✅ |

### 其他改动

| 文件 | 改动 |
| --- | --- |
| `src/components/admin-sidebar.tsx` | Blog 由 `available: false`（Coming Soon）改为 `true`，提示「博客管理」 |
| `src/middleware.ts` | matcher 增加 `'/blog/:path*'`（双层路由保护：middleware + 服务端 `/auth/me`） |
| `src/lib/media.ts` | `friendlyDeleteError` 扩展：`Media asset is in use.` → 「该媒体可能被产品图片或博客封面引用」 |

---

## E Security

| 项 | 实现 |
| --- | --- |
| 认证 | 三个控制器**类级** `@UseGuards(JwtAuthGuard)`；Admin 侧走 HttpOnly Cookie，浏览器 JS 拿不到令牌 |
| 输入校验 | 全部 DTO + `class-validator`（`@IsString`/`@IsOptional`/`@MaxLength`/slug 正则）；全局 `ValidationPipe` |
| 富文本 XSS | 写入前白名单净化（见 C）；标签、属性、URL 协议三层白名单 + 实体解码 + 控制字符过滤 |
| SQL 注入 | 全程 Prisma 参数化查询，无裸 SQL 拼接 |
| 敏感字段 | 响应不含 `passwordHash` 等；`author` 仅回传 `id` + `name` |
| 媒体删除保护 | 被产品图片**或**博客封面引用的媒体，删除返回 400 + 中文提示（覆盖两类业务引用） |
| **RBAC 预留（本阶段不实现）** | 权限校验集中在控制器级 Guard，业务 Service 不含角色判断；未来接入 `BLOG_CREATE/EDIT/DELETE` 权限码时无需重构 Service 层 |

---

## F Tests

### 后端（`bailing-backend`）

| 套件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `test/blog-cms.spec.ts` | 46 | 文章/分类/标签 CRUD、SEO 保存、**XSS 净化矩阵**、文档外壳保留正文、void 元素不吞内容 |
| `test/blog-cms.e2e-spec.ts` | 15 | 三类资源 CRUD、SEO 持久化、JWT 保护矩阵、Media 关联 |
| `test/media-cms.spec.ts` | 22 | 更新 mock（新增 `blogPost.count`），引用检查断言覆盖博客封面 |

**全量结果**：

```
Test Suites: 11 passed, 11 total
Tests:       176 passed, 176 total
```

质量门：`npm run lint` ✅ · `tsc --noEmit` ✅ · `npm run build` ✅

### Admin（`bailing-admin`）

`tsc --noEmit` ✅ · `eslint .` ✅ · `next build` ✅（输出含 `/blog`、`/blog/create`、`/blog/[id]/edit`、`/blog/categories`、`/blog/tags`）

---

## G 浏览器全流程验证（真实 UI）

验证脚本：`bailing-backend/docs/phase-4.4-browser-flow.mjs`（Playwright 直连，单会话真实浏览器）

```
===== Phase 4.4 博客 CMS 浏览器流程结束：PASS 38 / FAIL 0 =====
```

| # | 检查点 | 结果 |
| --- | --- | --- |
| 1 | 登录进入 `/dashboard` | PASS |
| 2 | 侧边栏「博客管理」可点击（非 Coming Soon） | PASS |
| 3 | 文章列表页渲染 + 二级导航 + 新建入口 | PASS |
| 4 | 分类管理：新建 + 列表 + 状态「启用」 | PASS |
| 5 | 标签管理：新建 + 列表 | PASS |
| 6 | 新建文章：富文本同步 / 分类选择 / 标签多选 / 状态 PUBLISHED / SEO 填写 / 创建跳转编辑页 | PASS |
| 7 | 编辑页：状态、SEO 标题/关键词、OG 标题、Twitter 标题**持久化**；分类标签关联；**发布时间自动填充**；**XSS 已过滤** | PASS |
| 8 | 媒体库上传可解码 PNG（640×480） | PASS |
| 9 | 封面选择弹窗 → 选中 → 弹窗自动关闭 → `coverMediaId` 写入 → 保存成功 | PASS |
| 10 | 列表页：文章出现 / 状态 / 分类 / 标签 / **封面缩略图真实加载（naturalWidth 640）** | PASS |
| 11 | 引用检查：删除被博客封面引用的媒体被拒 + 中文提示，媒体未被误删 | PASS |
| 12 | 两步确认删除文章 | PASS |
| 13 | 截图留档 + 全程无未捕获页面异常 | PASS |

截图：`bailing-backend/docs/phase-4.4-blog-list.png`

### 验证过程中的两个坑（已排除，非产品缺陷）

| 现象 | 根因 | 结论 |
| --- | --- | --- |
| 旧版 shell 脚本（`playwright-cli`）在第 6 步后连续返回空串 | `playwright-cli` 每次 `eval` 为独立进程调用，多次调用后会话失联 | **工具问题**，非产品缺陷；改用 Playwright 直连单会话脚本解决 |
| 首轮报告「SEO 标题未持久化」等 4 项 FAIL | 脚本用 `main.innerText` 断言 `<input>` 的 value（input 值不在 innerText 中） | **断言方式错误**，改用 `inputValue()` 后全 PASS |

---

## H 未来演进（SEO 与公开站接入）

本阶段完成**内容生产端**（Admin 写、后端存、API 出）。以下为公开站消费端的预留设计，本阶段不实现：

1. **公开站读取接口**：`bailing-ui` 通过后端只读接口（免鉴权）按 `status = PUBLISHED` 拉取文章列表与详情，字段直接消费 `seoTitle ?? title`、`seoDescription ?? excerpt` 回落规则。
2. **Sitemap / RSS**：后端按 `publishedAt` 生成 `/sitemap.xml` 与 `/rss.xml`，`canonicalUrl` 用于跨站转载指向原文。
3. **Open Graph / Twitter Card**：`ogTitle/ogDescription/ogImage`、`twitterTitle/twitterDescription` 已落库，公开站 `generateMetadata` 直接消费，无需二次改库。
4. **分类归档页**：`BlogCategory.slug`（可读 slug）对应 `/blog/category/[slug]`。
5. **RBAC 接入**：现有控制器级 Guard 替换为权限 Guard，权限码 `BLOG_CREATE` / `BLOG_EDIT` / `BLOG_DELETE`，Service 层无需改动。
6. **封面媒体迁移**：若未来把 `coverImageUrl` 完全切换为 `coverMediaId` 关联渲染，只需公开站读 `coverMedia.url`，数据层已有双写基础。

---

## I Git Commit 信息

### bailing-backend（分支 `261014` → ff 合入 `dev`）

```
feat(blog): Phase 4.4 Blog CMS + SEO 内容管理系统

- 数据库：演扩 Phase 1 预留 BlogPost（新增 coverMediaId/categoryId/featured/
  seoTitle/seoDescription/seoKeywords/canonicalUrl/og*/twitter*），
  新增 BlogCategory/BlogTag/BlogPostTag；手写迁移 20261014171544_add_blog_cms，
  migrate status 正常，migrate diff 输出为空（零漂移）
- Blog CMS API（/api/v1/cms/blog，控制器级 JwtAuthGuard）：
  posts CRUD（分页 + keyword/status/categoryId/tagId/featured 筛选）
  categories CRUD（含 postCount，分类下有文章禁止删除）
  tags CRUD（显式 join 模型 BlogPostTag，级联解绑）
- 富文本安全：自研白名单净化器（标签/属性/URL 协议三层白名单 + 实体解码 +
  控制字符过滤），无第三方依赖；修复文档外壳丢正文、void 元素吞内容两处边界缺陷
- 接线：cms.module 注册 BlogModule；media.service countReferences 扩展至
  BlogPost 封面引用；新增 common/validators/slug 单一来源（products 改再导出）
- 测试：blog 单测 46 + e2e 15；全量 176/176；lint / typecheck / build 全绿
- 文档：API-CONVENTIONS §12、DEVELOPMENT-LOG §11、PHASE-4.4-FINAL-REPORT、
  浏览器流程脚本（.mjs 直连版）与截图
```

### bailing-admin（分支 `261014` → ff 合入 `dev`）

```
feat(blog): Phase 4.4 Admin 博客管理（中文后台）

- /blog 文章列表（封面缩略图/标题/分类/状态/发布时间/更新时间/操作 +
  搜索 + 状态筛选 + 分类筛选 + 分页）、/blog/create、/blog/[id]/edit
- 富文本编辑器（H2/H3/段落/B/I/U/列表/引用/代码块/链接/图片/清除格式），
  图片经 MediaPickerModal 从 Phase 4.3 媒体库只读选取，不自行存储文件
- 分类管理 /blog/categories、标签管理 /blog/tags（含两级删除确认）
- 封面选择与预览、两步确认删除文章、SEO/OG/Twitter 表单分组
- 侧边栏启用 Blog 入口（原 Coming Soon）；middleware 增加 /blog/:path*
- 质量门：tsc / eslint / next build 全绿；浏览器全流程 38/38 PASS
```

> 推送说明：`github.com` 在当前网络环境不可达（代理 502 / 直连 TLS 失败），
> 提交留存本地分支，网络恢复后按 `261014 → dev` 推送（见任务 #24）。

---

## 交付物

| 类型 | 路径 |
| --- | --- |
| 迁移 | `bailing-backend/prisma/migrations/20261014171544_add_blog_cms/` |
| 后端模块 | `bailing-backend/src/modules/cms/blog/**` |
| 共用校验 | `bailing-backend/src/common/validators/slug.ts` |
| 后端测试 | `bailing-backend/test/blog-cms.spec.ts`、`test/blog-cms.e2e-spec.ts` |
| Admin 页面 | `bailing-admin/src/app/(dashboard)/blog/**`、`src/lib/blog.ts` |
| 浏览器验证 | `bailing-backend/docs/phase-4.4-browser-flow.mjs` |
| 截图 | `bailing-backend/docs/phase-4.4-blog-list.png` |
| 文档 | `docs/API-CONVENTIONS.md §12`、`docs/DEVELOPMENT-LOG.md §11`、本报告 |

### 运行中的服务（本地 + 局域网）

| 服务 | 本地 | 局域网 |
| --- | --- | --- |
| Admin 后台 | http://localhost:3001 | http://192.168.1.40:3001 |
| 主站 | http://localhost:3000 | http://192.168.1.40:3000 |
| 后端 API | http://127.0.0.1:4000/api/v1 | http://192.168.1.40:4000/api/v1 |

说明：`UPLOADS_BASE_URL` 已设为 `http://192.168.1.40:4000`，`CORS_ORIGINS` 已含 `192.168.1.40:3000/3001`。
管理员从局域网访问可正常看到博客封面图。若更换网络导致本机 IP 变化，需同步更新这两项并重启后端。

### 浏览器验证专用账号

`pw-blog@bailingwooden.test` / `Pw-Blog-2026!`（管理员，直插 DB，仅用于自动化验证）

---

## 明确未做（任务书禁止项）

Factory / Quality / Applications CMS、页面 Builder、用户管理、角色权限（RBAC）、邮件营销、CRM —— **均未实现，未触碰**。
