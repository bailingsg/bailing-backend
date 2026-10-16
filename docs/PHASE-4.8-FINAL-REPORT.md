# Phase 4.8 最终报告
## 前台 CMS 消费优化 + SEO 增强 + 缓存治理 + 性能优化

- 阶段：**Phase 4.8**
- 分支：`261017`（bailing-backend / bailing-ui / bailing-admin 三仓库一致）
- 日期：2026-10-16
- 结论：**Phase 4.8 COMPLETE**

---

## A. 阶段概述与交付范围

本阶段解决 Phase 4.7 遗留的「前台内容不新鲜 / 缓存不可控」问题，并补齐前台 SEO 与异常处理。
**不新增业务功能、不重构已完成的 CMS 后台**，只做消费侧（前台）优化与缓存治理。

交付物：

| 类别 | 内容 |
| --- | --- |
| 前台取数契约 | `src/lib/cms-tags.ts`（分层时长 + tag 契约）、`src/lib/cms-api.ts`（统一 `apiGet`） |
| 发布即刷新 | 前台 `POST /api/revalidate`；后端 `RevalidationModule`（`@Global`）+ 11 个 CMS 服务接入 |
| SEO | 动态 metadata、canonical、OG/Twitter、BreadcrumbList、sitemap、robots |
| 异常处理 | `not-found.tsx`、`error.tsx`、`global-error.tsx`、列表页 `loading.tsx`（route group 限定） |
| 验证脚本 | `docs/phase-4.8-cache-verify.mjs`、`docs/phase-4.8-seo-verify.mjs`、`docs/phase-4.8-browser-flow.mjs` |
| 测试 | `test/revalidation.spec.ts`（13 用例）、`test/helpers/revalidation-mock.ts` |
| 截图 | `docs/screenshots/phase-4.8/`（14 张） |

---

## B. 实施前仓库审计结论

按任务书要求「先审计、后实施」，对真实仓库（非文档）逐项核对后确认：

| 审计项 | 实施前实际状态 |
| --- | --- |
| 前台 `fetch` 调用点 | 仅 2 处（`cms-api.ts` 与 factory repository），其余走 repository 层 |
| 统一取数策略 | ❌ 无。各 repository 各自为政，无 tag、无分层 |
| 缓存时长 | ❌ 单一 `300s`（违反「禁止单一 300s 策略」） |
| 发布即刷新 | ❌ 完全缺失，内容改动需等 ISR 过期或重新构建 |
| 前台 revalidate 端点 | ❌ 不存在 |
| 后端 Cache-Control | ❌ 无（公开读接口无缓存头） |
| BreadcrumbList | ❌ 无 |
| 静态页 `generateMetadata` | ❌ `/`、`/about`、`/contact`、`/factory` 为静态 `metadata` |
| `allowIndexing` | ❌ 硬编码 `false`（生产 robots 会误封整站） |
| applications 详情页 | ❌ 不存在 |
| factory repository | ⚠️ 进程级 `apiImageCache`，绕过 revalidation → 脏读 |
| applications 列表 | ⚠️ N+1 请求（每条记录单独拉关联产品） |

以上全部在本阶段修复。

---

## C. 硬性边界遵守情况

| 边界 | 遵守情况 |
| --- | --- |
| **禁止接入 COS / CDN** | ✅ 未接入。保持 `MediaAsset → Storage Adapter → Local Storage`，未改动 `STORAGE_PROVIDER=LOCAL` |
| 禁止重新开发已完成功能 | ✅ 未重写 CMS 后台；仅消费侧优化 |
| 禁止虚构数据与测试结果 | ✅ 所有断言均来自真实运行输出；无数据时显示空态 / 「待补充」 |
| 禁止引入新字段（数据库） | ✅ 本阶段**零迁移**（`migrate status` 12/12 up to date，`migrate diff` 无漂移） |
| 生产必须 api 模式 | ✅ `NEXT_PUBLIC_CMS_SOURCE=api`（已写入 `.env`，构建与运行均确认） |

---

## D. 统一取数策略与分层缓存

### D.1 分层缓存契约（`src/lib/cms-tags.ts`）

```ts
export const CmsRevalidate = {
  STABLE:   3600,  // 公司介绍 / 工厂 / 质量 / 站点分区 / 导航 / 分类
  CONTENT:   300,  // 产品 / 应用场景 / 博客
  REALTIME:    0,  // 员工公开联系方式 → no-store
} as const;
```

### D.2 缓存 tag 契约（前后端**逐字对应**）

```
products | product:{slug} | categories
blog | blog:{slug} | blog-categories
applications | application:{slug}
factory | quality | site | navigation | contacts
```

后端 `src/modules/revalidation/cms-tags.ts` 与前台 `src/lib/cms-tags.ts` 字符串完全一致，
任一改动必须双向同步（已在两处文件头注明）。

### D.3 构建输出实测（`next build`，api 模式）

```
┌ ○ /                     1.17 kB  199 kB   1h   1y
├ ○ /about                1.17 kB  199 kB   1h   1y
├ ○ /factory              1.16 kB  199 kB   1h   1y
├ ○ /quality              1.16 kB  199 kB   1h   1y
├ ○ /applications         1.17 kB  199 kB   5m   1y
├ ● /applications/[slug]  1.17 kB  199 kB
├ ƒ /blog                 1.16 kB  199 kB          ← Dynamic
├ ● /blog/[slug]          1.17 kB  199 kB
├ ƒ /products             1.16 kB  199 kB          ← Dynamic
├ ● /products/[slug]       1.6 kB  199 kB   5m   1y
├ ƒ /contact              5.31 kB  198 kB          ← Dynamic（含 RFQ 表单）
├ ƒ /api/revalidate        138 B  103 kB
└ ○ /sitemap.xml           138 B  103 kB   5m   1y
```

分层生效：STABLE=1h、CONTENT=5m、动态页（列表 / 表单 / 端点）=Dynamic。

### D.4 后端 Cache-Control（`app.setup.ts` 中间件，实测）

| 接口 | 响应头 |
| --- | --- |
| `GET /api/v1/products` | `public, max-age=60, stale-while-revalidate=300` |
| `GET /api/v1/public/blog` | `public, max-age=60, stale-while-revalidate=300` |
| `GET /api/v1/cms/site/sections` | `no-store` |

规则：仅 `GET` + 匹配 `/api/v1/(public/|products|categories)` 才给公共缓存，其余（含全部 CMS 写接口、鉴权接口、RFQ）一律 `no-store`。

---

## E. 发布即刷新与 Revalidation 安全

### E.1 链路

```
Admin 保存
  → Backend CMS Service（写入成功）
      → RevalidationService.invalidate({ tags, paths })
          → POST http://<frontend>/api/revalidate
              （header x-revalidate-secret + body { tags, paths, revalidateLayout }）
              → revalidateTag(...) / revalidatePath(..., 'page'|'layout')
```

`RevalidationService` 关键设计：
- **绝不抛异常**（内容写入已成功，失效失败不得回滚业务）；
- 3s 超时（`AbortController`）；
- 未配置 URL/Secret 时静默降级并告警；
- 单测覆盖 401 / 403 / 网络异常 / 503 四类失败路径。

### E.2 接入范围（11 个 CMS 服务）

`site-sections`（page 路径 + `site`）、`nav-items`（`layout` 粒度 + `navigation`）、
`products`（+ `/sitemap.xml`）、`product-categories`、`blog-posts`（+ `/sitemap.xml`）、
`blog-categories`、`blog-tags`、`factory-sections`、`quality-records`、
`applications`（+ `/sitemap.xml`）、`contacts`。

### E.3 端点安全（实测，`phase-4.8-cache-verify.mjs` Part 0）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| `GET /api/revalidate` | 405 | ✅ 405 |
| POST 缺少密钥 | 401 | ✅ 401 |
| POST 密钥错误 | 401 | ✅ 401 |
| 错误响应不泄漏内部信息 | 无泄漏 | ✅ `{"revalidated":false,"error":"unauthorized"}` |
| POST 空 tag/path | 400 | ✅ 400 |
| 密钥来源 | 仅环境变量 | ✅ `REVALIDATE_SECRET`（64 位 hex，非 `NEXT_PUBLIC_`） |

---

## F. SEO 增强

- 9 个页面全部输出完整 metadata：`title` / `description` / `keywords` / `canonical` /
  `robots` / `openGraph`（type,url,siteName,title,description,locale,images）/ `twitter`（card,title,description,images）。
- `/`、`/about`、`/contact`、`/factory` 由静态 `metadata` 改为 `generateMetadata()`，
  内容由 CMS 分区驱动（`getCmsPageSeo`）。
- `title.template` 只作用于子路由，首页使用绝对标题（沿用既有约定）。
- **禁止 undefined/null 进入 title/description**：已断言（90 项 SEO 断言全绿）。
- 不存在的 slug 返回 `Product/Article/Application Not Found` 且 `robots: noindex,nofollow`。

---

## G. Sitemap / Robots / Canonical 治理

### G.1 Canonical 生产域名护栏（`src/config/site.ts`）

生产构建（`NODE_ENV=production`）下，若 `NEXT_PUBLIC_SITE_URL` 指向本机 / 私网
（`localhost`、`127.0.0.1`、`::1`、`*.local`、`10./192.168./172.16-31./169.254.`），
**直接回退 `https://bailingwooden.com` 并告警**，避免 canonical / og:url / sitemap 写入内网地址。
开发环境允许本地地址以便联调。

### G.2 robots（`src/app/robots.ts`）

```
User-Agent: *
Allow: /
Disallow: /api/
Disallow: /design-system

Host: https://bailingwooden.com
Sitemap: https://bailingwooden.com/sitemap.xml
```

`allowIndexing` 改为**环境感知**：生产默认 `true`（Allow: /），开发默认 `false`；
可用 `NEXT_PUBLIC_ALLOW_INDEXING=true|false` 显式覆盖。

### G.3 sitemap（`src/app/sitemap.ts`）

- 真实读库（产品 / 博客 / 应用场景 slug）；
- 仅含 `PUBLISHED` 内容（**不含 Draft / Archived / 已删除**，实测通过）；
- 不含内部预览页 `/design-system`；
- 全部使用生产域名（无 localhost / 192.168.x）；
- `allowIndexing=false` 时返回空数组。

---

## H. 结构化数据

| 页面 | Schema |
| --- | --- |
| 首页 | `Organization` |
| 产品详情 | `Product` + `BreadcrumbList` |
| 博客详情 | `Article` + `BreadcrumbList` |
| 应用场景详情 | `WebPage` + `BreadcrumbList` |

- **禁止虚构价格 / 库存 / 评分 / 评论**：已断言 `offers` / `price` / `aggregateRating` /
  `review` / `availability` 等键**全部不存在**（实测通过）。
- JSON-LD 注入防护：`JSON.stringify(schema).replace(/</g, '\\u003c')`。
- 应用场景明确**不输出** Product schema。

---

## I. 异常处理与缓存安全

| 项 | 实现 |
| --- | --- |
| `not-found.tsx` | 根级统一 not-found（品牌化） |
| `error.tsx` | 路由级错误边界（不含堆栈 / Prisma / SQL） |
| `global-error.tsx` | 根级错误边界，自带 `<html>/<body>` |
| `loading.tsx` | 仅列表路由：`products/(catalog)/loading.tsx`、`blog/(list)/loading.tsx` |
| API 错误 | `apiGet` 统一解析 `{success,error}`；404 → `null`，其余抛出由 error 边界接管 |
| Cache-Control | 见 D.4；**RFQ / 内部信息 / JWT / 账号接口一律 `no-store`** |
| 缓存污染防护 | 移除 factory 的进程级 `apiImageCache`（曾绕过 revalidation 造成脏读） |

### I.1 关于 `loading.tsx` 作用域（重要）

`loading.tsx` 会在其所在 segment 建立 **Suspense 流式边界**。Next.js 对流式响应固定返回
HTTP **200**，因此 `notFound()` 会退化为「软 404」。实测：

- 根级 `app/loading.tsx` 存在 → `/products/<不存在>` 返回 **200**（软 404）；
- 移除后 → 返回 **404**。

解决方案：**列表路由改用 route group**（`products/(catalog)`、`blog/(list)`），
使 `loading.tsx` 只覆盖列表页，不再成为详情页的 Suspense 祖先；
详情页保留加载态由浏览器原生导航与 `<Link>` prefetch 覆盖。

---

## J. 关键缺陷与修复记录

### J.1 【P0】`dynamicParams = false` 导致缓存失效后详情页整页 404

**现象**：CMS 一修改产品，前台**所有**产品详情页立刻返回 404 并长期保持（直到重启服务）。

**根因**：`dynamicParams = false` 会把该动态路由标记为 `fallback: NOT_FOUND`。
当 route-cache 条目被 `revalidateTag` / `revalidatePath` / 过期时间失效后，
Next 路由模块拿不到 `previousCacheEntry`，`fallbackMode` 仍为 `NOT_FOUND`，
于是抛出内部 `NoFallbackError` → 404，且该 404 会被写入 route-cache 持续生效。
（Next 15.5.27，`node_modules/next/dist/build/templates/app-page.js:494-501`）

**影响**：与 Phase 4.8 的核心目标「发布即刷新」完全相反 —— 越发布，页面越不可用。

**修复**：`dynamicParams = false` → `true`（三个详情路由：products / blog / applications）。
Next 15 会把渲染期 `metadata.statusCode` 存入 route-cache，读取时以
`res.statusCode = cachedData.status` 原样回放，因此**真实 404 依然成立**。

### J.2 【P1】`loading.tsx` 造成软 404

见 I.1。修复：列表路由改用 route group 限定作用域；移除根级与详情级 `loading.tsx`。

### J.3 其它修复

| 项 | 说明 |
| --- | --- |
| applications 列表 N+1 | 改为单请求 `fetchApiApplicationList()`，列表/详情映射函数分离 |
| factory 脏读 | 移除进程级缓存，改用 fetch 去重 + `CmsTags.factory` tag |
| 旧单测编译失败 | 4 个 spec 因服务新增构造参数编译失败 → 新增 `test/helpers/revalidation-mock.ts` 并注入 |
| `global-error.tsx` lint | `<a>` → `next/link`（`no-html-link-for-pages`） |

---

## K. 验证结果

### K.1 后端测试（`npx jest`）

```
Test Suites: 18 passed, 18 total
Tests:       306 passed, 306 total
```

含本阶段新增 `test/revalidation.spec.ts`（13 用例）。

### K.2 缓存与发布即刷新（`phase-4.8-cache-verify.mjs`）

```
总计 30 项断言，通过 30，失败 0   ✓ 全部通过
```

覆盖：

| 组 | 断言 |
| --- | --- |
| Part 0 revalidate 安全 | GET→405 / 无密钥→401 / 错密钥→401 / 无泄漏 / 空载荷→400 |
| Part 1 预渲染 slug 失效 | 预渲染页可访问 → 改名即时反映 → **不再 404（回归修复）** → 列表同步 → 还原 |
| Part 2 Test A–E | 新建出现 → **A 修改** → **C Draft→404+消失** → **D Archived→404+消失** → **E 重新发布→恢复** → **B 删除→404+消失** |
| Part 3 缓存污染 | `.next/cache` 未被清空（49→53 文件）；改库后下次请求即最新；数据已还原 |

全程**未删除 `.next/cache`**，也未重新构建。

### K.3 SEO（`phase-4.8-seo-verify.mjs`）

```
总计 90 项断言，通过 90，失败 0   ✓ 全部通过
```

9 个页面 × (200/title/description/canonical/OG/og:url/Twitter/robots) +
结构化数据 5 项 + sitemap 7 项 + robots 4 项 + 404 不索引 2 项。

### K.4 浏览器全流程（`phase-4.8-browser-flow.mjs`，Playwright 单会话）

```
总计 50 项，通过 50，失败 0   ✓ 全部通过
```

| 组 | 断言 |
| --- | --- |
| A 前台渲染 | 9 个页面 200 + 预期内容 |
| B 浏览器内 SEO | title / canonical（生产域名）/ og:title / JSON-LD |
| C 真实 404 | 产品 / 文章 / 应用场景不存在 → **404** + not-found 界面 |
| D 发布即刷新 | 后台改名 → 新会话前台即时可见 → 还原同步 |
| E 响应式 | **375 / 390 / 768 / 1440** × 6 个页面，**零横向溢出** |
| F 控制台 | 无 console error / pageerror |

### K.5 质量门

| 仓库 | lint | typecheck | build | test |
| --- | --- | --- | --- | --- |
| bailing-backend | ✅ | ✅ | ✅ `nest build` | ✅ 306/306 |
| bailing-ui | ✅ | ✅ | ✅ `next build`（api 模式） | ✅ 浏览器 50/50 |
| bailing-admin | ✅ | ✅ | — | —（**Admin code unchanged.**） |

### K.6 数据库

```
12 migrations found in prisma/migrations
Database schema is up to date!
migrate diff → "This is an empty migration."（无漂移）
```

本阶段**未新增迁移**、未改历史迁移、未 reset。

---

## L. Git、服务状态与后续建议

### L.1 Git

- 分支：`261017`（三仓库一致，未动 `master`，未 force push）
- 提交内容：见 N 节提交清单

### L.2 最终服务状态（生产模式）

| 服务 | 地址 | 模式 |
| --- | --- | --- |
| bailing-ui | `http://localhost:3000` / `http://192.168.1.40:3000` | `next start`（`NEXT_PUBLIC_CMS_SOURCE=api`） |
| bailing-admin | `http://localhost:3001` / `http://192.168.1.40:3001` | `next start` |
| bailing-backend | `http://localhost:4000` | `nest build` + `start:prod` |
| postgres | `127.0.0.1:5432`（容器 `bailing-postgres`） | — |

### L.3 已知限制

1. **`loading.tsx` 无法用于详情路由**：Next.js 流式响应固定 200，与真实 404 冲突
   （上游 issue：vercel/next.js#76474）。当前以 route group 限定在列表路由。
2. **详情页按需生成**：`dynamicParams = true` 下未预渲染的 slug 会在首次访问时生成，
   首访 TTFB 略高于预渲染页（其后走 route-cache）。
3. **图片跨设备可见性**：`UPLOADS_BASE_URL` / `CORS_ORIGINS` 依赖当前局域网 IP
   （`192.168.1.40`），换网络需同步更新（既有约定）。

### L.4 后续建议

1. 后台「媒体删除」目前触发**全内容 tag** 失效（`MEDIA_DEPENDENT_TAGS`），
   可按引用关系收敛为精准失效，降低失效面。
2. 可在 CI 中加入 `phase-4.8-cache-verify.mjs` / `phase-4.8-seo-verify.mjs` 作为回归门禁。
3. 部署到正式域名后，建议在 `robots.txt` 之外补 `security.txt` 与 GSC 校验文件。

---

## 附：提交清单

见 `git log --oneline -3` 于 `261017` 分支（提交哈希记录于推送复核输出）。
