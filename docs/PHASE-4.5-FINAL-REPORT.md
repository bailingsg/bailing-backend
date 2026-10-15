# Phase 4.5 Final Report

**阶段**：Phase 4.5 —— 百灵木业 Factory / Quality / Applications 企业内容 CMS
**日期**：2026-10-15
**分支**：`261014`（backend + admin，从 dev 拉取）
**结论**：**全部完成，所有质量门以真实运行结果通过；浏览器端到端 34/34 PASS。**

---

## A. 完成状态

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 数据库模型与迁移 | ✅ 完成 | 纯新增，3 枚举 + 6 表，零漂移 |
| Backend Factory CMS | ✅ 完成 | 6 个受保护接口 |
| Backend Quality CMS | ✅ 完成 | 5 个受保护接口 |
| Backend Applications CMS | ✅ 完成 | 5 个受保护接口 |
| 公开只读 API | ✅ 完成 | 5 个免鉴权接口 |
| Admin 三模块中文界面 | ✅ 完成 | 21 个新文件，9 条新路由 |
| 后端测试 | ✅ 完成 | 新增 39 单测 + 23 e2e；合计 238/238 |
| 浏览器端到端验证 | ✅ 完成 | 34/34 PASS，24 张截图 |
| 文档 | ✅ 完成 | 本报告 + API-CONVENTIONS §13 + DEVELOPMENT-LOG §12 |

**未做（按阶段禁令）**：员工账号、RBAC、导航权限、CRM、邮件营销、页面 Builder、
媒体库重写、COS/CDN、整站前端重构。

---

## B. 实际修改的仓库及文件

### bailing-backend

**修改（9）**
- `prisma/schema.prisma` — 新增 3 枚举 + 6 模型；MediaAsset 增 4 条反向关系；Product 关系改名 `applicationLinks`
- `src/app.module.ts` — 注册 `PublicModule`
- `src/modules/cms/cms.module.ts` — 注册 Factory/Quality/Applications 模块
- `src/modules/media/media-file.util.ts` — 拆分图片/文档 MIME 白名单，签名校验支持 `%PDF-`
- `src/modules/media/media.service.ts` — 归类 IMAGE/DOCUMENT；`countReferences` 扩展至三模块
- `src/modules/media/media.controller.ts` — 文案与 Swagger 说明适配 PDF
- `src/modules/media/storage/local-storage.provider.ts` — 复用新 MIME 表
- `test/media-cms.spec.ts` — 扩展 prisma mock（4 个新 count）
- `test/media-cms.e2e-spec.ts` — 断言消息更新

**新增**
- `prisma/migrations/20261015112244_add_enterprise_cms/migration.sql`（212 行）
- `src/modules/cms/factory/`：`entities/factory.entity.ts`、`dto/factory-section.dto.ts`、
  `dto/list-factory-sections-query.dto.ts`、`factory-sections.service.ts`、
  `factory-sections.controller.ts`、`factory.module.ts`
- `src/modules/cms/quality/`：`entities/quality.entity.ts`、`dto/quality-record.dto.ts`、
  `dto/list-quality-records-query.dto.ts`、`quality-records.service.ts`、
  `quality-records.controller.ts`、`quality.module.ts`
- `src/modules/cms/applications/`：`entities/application.entity.ts`、`dto/application.dto.ts`、
  `dto/list-applications-query.dto.ts`、`applications.service.ts`、
  `applications.controller.ts`、`applications.module.ts`
- `src/modules/public/`：`entities/public.entity.ts`、`dto/public-list-query.dto.ts`、
  `public-factory.service.ts`、`public-quality.service.ts`、`public-applications.service.ts`、
  `public-factory.controller.ts`、`public-quality.controller.ts`、
  `public-applications.controller.ts`、`public.module.ts`
- `test/enterprise-cms.spec.ts`（39 用例）、`test/enterprise-cms.e2e-spec.ts`（23 用例）

### bailing-admin

**修改（3）**
- `src/components/admin-sidebar.tsx` — 三个模块由 Coming Soon 改为可用（中文 hint）
- `src/lib/media.ts` — `mediaTypeLabel` 增加 `application/pdf → PDF`
- `src/lib/format.ts` — 新增 `formatDate()`（Asia/Shanghai，仅日期）

**新增**
- `src/lib/enterprise.ts` — 三模块类型 + API 访问层 + 友好错误 + 克制到期提示
- `src/app/(dashboard)/factory/`：`actions.ts`、`page.tsx`、`factory-form.tsx`、
  `media-picker.tsx`、`delete-factory-button.tsx`、`create/page.tsx`、`[id]/edit/page.tsx`
- `src/app/(dashboard)/quality/`：`actions.ts`、`page.tsx`、`quality-form.tsx`、
  `media-picker.tsx`、`delete-quality-button.tsx`、`create/page.tsx`、`[id]/edit/page.tsx`
- `src/app/(dashboard)/applications/`：`actions.ts`、`page.tsx`、`application-form.tsx`、
  `cover-picker.tsx`、`product-picker.tsx`、`delete-application-button.tsx`、
  `create/page.tsx`、`[id]/edit/page.tsx`

---

## C. 数据库模型及 Migration

**迁移**：`20261015112244_add_enterprise_cms`（纯新增，未改动任何历史迁移）

**枚举**
- `ContentStatus { DRAFT, PUBLISHED }`（刻意独立于博客 `PostStatus`）
- `FactorySectionType { OVERVIEW, FACILITY, EQUIPMENT, PRODUCTION, LOADING, EXHIBITION }`
- `QualityRecordType { CERTIFICATION, TEST_REPORT, QUALITY_CONTROL, STANDARD }`

**表（6）**

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `factory_sections` | title/slug/sectionType/summary/content/coverMediaId/status/sortOrder/seo*/publishedAt | slug `@unique` |
| `factory_images` | sectionId/mediaId/altText/sortOrder/**exhibitionId(可空)** | `null`=图库，非空=展会照片 |
| `factory_exhibitions` | sectionId/name/heldOn/location/description/sortOrder/isVisible | 结构化展会 |
| `quality_records` | title/slug/recordType/issuer/certificateNumber/issueDate/expiryDate/description/mediaId/status/sortOrder/seo*/publishedAt | 机构/编号/日期**全可空** |
| `applications` | name/slug/summary/description/coverMediaId/status/featured/sortOrder/seo*/publishedAt | — |
| `application_products` | `@@id([applicationId, productId])` + sortOrder | 显式 M2M |

**外键策略**：Factory 图库/展会随分区 `Cascade`；`ApplicationProduct` → Application `Cascade`、
→ Product **`Restrict`**（保护产品）；MediaAsset 关联 `SetNull`（不因删内容而删媒体）。
**索引**：slug unique；`(status, sortOrder)`、`publishedAt` 均建索引。

**验证结果（实测）**
```
prisma migrate status  → 7 migrations found · Database schema is up to date!
prisma migrate diff    → -- This is an empty migration.   （零漂移）
\dt 确认 6 张新表均已创建
```

---

## D. Factory 功能清单

- 完整 CRUD（列表分页 + 关键词 + `sectionType` + `status` 过滤）
- 六种内容类型；**展会为结构化模型**（名称/日期/地点/说明/可见性/排序/照片），非单一 JSON
- 封面（`coverMediaId`）+ 图库（多图，支持 ALT、排序、解除关联）
- **「解除关联」≠「删除媒体文件」**：解除仅清空关联字段，`MediaAsset` 原样保留
- 删除工厂内容**不删除**任何被其他内容引用的 `MediaAsset`
- 正文 HTML 经 `sanitizeRichText` 白名单净化
- slug 唯一（409）、SEO 标题/描述、草稿/发布、发布时间、排序

---

## E. Quality 功能清单

- 完整 CRUD（列表分页 + 关键词 + `recordType` + `status` 过滤）
- 四种记录类型：认证证书 / 检测报告 / 质量控制 / 执行标准
- `issuer / certificateNumber / issueDate / expiryDate` **均可留空**（空空即存 `null`）
- 部分更新安全：未提交字段不被覆盖；`''` → `null`
- PDF 证书 / 报告经媒体库关联（Phase 4.5 新增 DOCUMENT 支持）
- **数据诚实**：不编造任何认证名称/编号/检测结果/有效期；**无到期日不推断过期**
- **未发布记录的证书不会被公开接口读出**

---

## F. Applications 功能清单

- 完整 CRUD（列表分页 + 关键词 + `status` + `featured` 过滤）
- 关联产品为**显式多对多**（`ApplicationProduct`），基于 `productId`，**不用名称字符串**
- 更新时 `products[]` 整体替换（差集删除 + upsert 保留排序），并去重
- **删除应用场景不删除任何产品**
- 封面图、推荐位开关、SEO、草稿/发布、排序

---

## G. 后台中文界面验证

| 列表页 | 列（实测存在） |
| --- | --- |
| 工厂实力 `/factory` | 封面 / 标题 / 内容类型 / 发布状态 / 排序 / 更新时间 / 操作 |
| 质量体系 `/quality` | 标题 / 记录类型 / 认证机构 / 证书编号 / 有效期 / 发布状态 / 操作 |
| 产品应用场景 `/applications` | 封面 / 场景名称 / 关联产品数 / 发布状态 / 是否推荐 / 排序 / 操作 |

- 全部界面**中文**；前端英文站未受影响（无中文外泄）
- 空态 / 加载 / 错误态齐备；保存有成功反馈；表单校验 + 重复提交保护（`pending` 禁用）
- 删除**一律页内两步确认**（「删除」→「确认」），**不使用原生 `confirm()`**
- 响应式：桌面表格 / 移动卡片 + 汉堡菜单（截图 `22-mobile-*.png`）
- 侧边栏三模块由 Coming Soon 改为可用，hint 为中文（应用场景 / 工厂实力 / 质量体系）

---

## H. Backend API 清单

**受保护（`@UseGuards(JwtAuthGuard)`，前缀 `/api/v1`）**

| 模块 | 接口 |
| --- | --- |
| Factory | `GET/POST /cms/factory`、`GET /cms/factory/:id`、`GET /cms/factory/:id/exhibitions`、`PATCH /cms/factory/:id`、`DELETE /cms/factory/:id` |
| Quality | `GET/POST /cms/quality`、`GET/PATCH/DELETE /cms/quality/:id` |
| Applications | `GET/POST /cms/applications`、`GET/PATCH/DELETE /cms/applications/:id` |

RFQ 的 `X-Admin-Token` 机制**完全未改动**。

---

## I. 公开 API 及发布规则

| 接口 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /public/factory` | 无 | 仅已发布；page/pageSize（≤48） |
| `GET /public/factory/:slug` | 无 | 非 PUBLISHED → 404；展会仅 `isVisible` |
| `GET /public/quality` | 无 | 仅已发布 |
| `GET /public/applications` | 无 | 仅已发布 |
| `GET /public/applications/:slug` | 无 | 关联产品仅 `status=PUBLISHED` |

**实测验证**
```
公开列表       → 仅含已发布记录（total=1，草稿被排除）
已发布 slug    → HTTP 200
草稿 slug      → HTTP 404（不泄露存在性）
内部字段扫描   → storageKey / createdBy / provider / status / sortOrder 零出现
```
- 响应经 DTO 白名单映射；不暴露服务器真实路径；不泄露未公开证书
- 质量记录 `isExpired`：无到期日返回 `null`（不臆断）

---

## J. Media Library 关联设计

- **复用** Phase 4.3 媒体库，三模块**一律禁止 `fs.writeFile()`**
- 媒体删除保护 `countReferences` 已扩展覆盖：Product 图、Blog 封面、Factory（封面+图库）、
  Quality（文件）、Application（封面）→ 被引用删媒体返回 **400 `Media asset is in use.`**
- 不硬编码 CDN 域名、不接入 COS SDK、不改动既有 URL 生成逻辑
- 上传按 MIME 归类：图片 → `IMAGE`，PDF → `DOCUMENT`（新增 `isDocumentMime`）

---

## K. SEO 能力

- 三模块均有 `slug / seoTitle / seoDescription`
- slug `@unique` + 共享正则校验（`src/common/validators/slug.ts`）
- SEO 字段长度校验（标题 200 / 描述 500）
- 草稿不出现在公开 API；未发布内容不进 sitemap 数据源
- Factory 与 Applications 具备公开详情页 URL；Quality 详情按记录类型区分
- **无编造 SEO 文案与业务事实**；未做全站 SEO 管理中心 / 站点地图生成

---

## L. 安全检查

| 项 | 结果 |
| --- | --- |
| 写操作 JWT 保护 | ✅ 三 controller 全部 `@UseGuards(JwtAuthGuard)` |
| DTO 校验 + 白名单 | ✅ 全局 ValidationPipe（whitelist + forbidNonWhitelisted） |
| HTML 净化 / XSS | ✅ 复用自建 `sanitizeRichText` 白名单净化器 |
| Prisma 安全访问 | ✅ 全部参数化查询，无字符串拼接 SQL |
| 媒体存在性校验 | ✅ 悬空 `mediaId` → 400 |
| 非法产品关联防护 | ✅ M2M 外键 + 产品存在性校验 |
| 被引用媒体删除防护 | ✅ 400（实测） |
| 公开接口字段白名单 | ✅ 实测零泄漏 |
| 404 / 非法状态处理 | ✅ 非 PUBLISHED 按 slug 查询 → 404 |
| 日志敏感信息 | ✅ 未记录任何令牌/口令 |
| RBAC | ⏸ 本阶段不做，但 controller 注释预留接入点，未散落硬编码权限判断 |

---

## M. 测试结果

**后端 Jest —— 238/238，13/13 套件全通过**

| 套件 | 内容 |
| --- | --- |
| `enterprise-cms.spec.ts`（39） | Factory CRUD/排序/状态/媒体存在性；Quality 创建/更新/日期空值保留/发布规则；Applications CRUD/M2M/去重/删除完整性 |
| `enterprise-cms.e2e-spec.ts`（23） | JWT 矩阵（16 探针 → 401）、公开接口免鉴权、PNG+PDF 上传、409/404、媒体删除保护、发布规则、引用完整性 |
| 其余 11 套件 | 4.1–4.4 回归（auth / rfq / health / products / media / blog 等） |

**浏览器端到端 —— 34/34 PASS**（`docs/phase-4.5-admin-e2e.mjs`，Playwright 直连单会话，真实 Chromium）

覆盖任务书 §14 全部 10 项：①登录 ②三模块中文界面 ③新建/编辑工厂内容
④Factory 选图 ⑤新建质量记录+关联文件 ⑥新建应用场景+关联产品 ⑦发布/撤回/删除
⑧搜索/筛选/排序 ⑨表单与 API 错误处理 ⑩桌面+移动端布局。控制台 **0 严重错误**。

截图：`docs/phase-4.5-screenshots/`（24 张）+ `_results.json`。

---

## N. Build / lint / typecheck

| 侧 | 命令 | 结果 |
| --- | --- | --- |
| backend | `npm run lint` | ✅ 0 error / 0 warning |
| backend | `npx tsc --noEmit` | ✅ exit 0 |
| backend | `npm run build`（nest build） | ✅ exit 0 |
| backend | `npx jest` | ✅ 238/238 |
| prisma | `migrate status` | ✅ 7 migrations，up to date |
| prisma | `migrate diff` | ✅ 空迁移（零漂移） |
| admin | `npm run lint` | ✅ 0 error / 0 warning |
| admin | `npx tsc --noEmit` | ✅ exit 0 |
| admin | `npm run build`（next build） | ✅ exit 0，新增 9 条路由 |

**Phase 4.1–4.4 回归**：全部既有测试通过，服务未中断，端口未改，RFQ 令牌机制未动。

---

## O. Git Commit 与远程推送状态

- 分支：`261014`（backend + admin 双侧一致）
- 提交前工作区已核对：**无用户未提交改动被覆盖**；本阶段改动全部为新增/预期修改
- `.env` 与任何密钥**未纳入提交**
- **远程推送状态**：见本报告交付时的实际执行结果（以真实 `git push` 输出为准，不虚构）。
  若 GitHub 侧不可达，则如实记录「本地已提交、远程未推送」，绝不声称推送成功。

---

## P. 已知问题及未完成事项

1. **RBAC 未实现**：本阶段仅有 JWT 鉴权，无角色/权限码。已在 controller 预留注释接入点。
2. **公开站（bailing-ui）消费端未接入**：本阶段只交付公开只读 API 与映射，未做大规模前端重构。
3. **Sitemap / RSS 未生成**：未发布内容不进数据源的设计已就位，生成器属后续阶段。
4. **媒体库中存留 2 个 E2E 测试资产**（1 PNG + 1 PDF，未被引用，可安全删除）。
5. **`FactorySection.content` 为 HTML**：已做白名单净化，但未接入编辑器（沿用纯文本域输入）。
6. **Quality 到期提示为 90 天阈值**：为克制提示的经验值，非业务规则，可按需调整。

---

## Q. 下一阶段建议

1. **Phase 4.6 公开站接入**：bailing-ui 消费 `/public/*`，落地工厂/质量/应用三套详情页与列表页。
2. **RBAC 落地**：角色模型 + 权限码 + 导航权限，替换当前 controller 注释预留点。
3. **Sitemap / RSS 生成器**：以 `status=PUBLISHED` 为数据源，纳入 slug 与更新时间。
4. **富文本编辑器接入**：为 `FactorySection.content` 与 Blog 正文接入受控编辑器（仍走净化器）。
5. **媒体库体验增强**：批量上传、拖拽排序、引用计数可视化（引用保护逻辑已就绪）。
6. **Quality 到期提醒**：基于 `expiryDate` 的管理端列表高亮 / 邮件提醒（需先做通知基础设施）。
