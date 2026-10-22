# Phase 5.4 迁移最终报告（模拟数据清理 + 旧站产品与文章迁移）

- 执行时间：2026-10-19 11:11 – 14:10 (GMT+8)
- 执行环境：本地开发环境（D:\com.bailingwooden）
- 总体状态：**COMPLETE**（本地目标范围内的全部任务完成；遗留事项见第九节）

---

## 一、总体结论

| 指标 | 源站（实测） | 迁移成功 | 跳过 | 失败 | 待人工处理 |
|---|---:|---:|---:|---:|---:|
| 产品 | 34 | 34 | 0 | 0 | 0 |
| 文章 | 75 | 75 | 0 | 0 | 0 |
| 产品图片（图集附件） | 113（134 文件） | 113 | 0 | 0 | 0 |
| 文章图片（封面+内嵌附件） | 125 | 125 | 0 | 0 | 0 |
| 媒体注册（去重附件） | 238 | 239* | 0 | 0 | 0 |

\* 239 = 238 个唯一附件 ID（113 产品 + 125 文章）+ 1 个同 ID 双桶附件；每个附件一个 MediaAsset，无多余注册。

模拟数据清理：删除 325 行测试记录 + 50 个孤儿文件，全部有识别依据，零误删（详见 `phase-5.4-inventory-and-cleanup-report.md`）。

## 二、源站盘点（Phase 5.4.3a）

- 数据来源：WordPress REST API（只读）：`/wp-json/wp/v2/product`（34，分页完整）、`/wp-json/wp/v2/posts`（75，分页完整）、`/wp-json/wp/v2/pages`（7，仅盘点）、术语端点 4 个
- `wc/store/v1/products` 返回空（未开放）→ 改用 `wp/v2/product`，字段完整性经 Yoast/分类/标签核验
- sitemap 在站点缓慢期不可达（exit 52 空回复）→ 以 REST 全量分页 + 2026-10-13 本地导出 manifest 双重核对，数量一致
- 抓取脚本：`fetch-legacy-content.py`（v1，产品）+ `fetch-legacy-content-v2.py`（v2，分页落盘断点续传）；站点极慢（90-120s/页超时、代理间歇 502），经指数退避重试全部抓齐（fetch-stats-v2.json）
- 清单文件：`legacy-content-inventory.json`（34 产品 + 75 文章 + 7 页面，机器可读）

## 三、本地图片复用（任务第六节）

- 图片源：`C:\Users\Administrator\Desktop\bailing-image-export`（用户指定，2026-10-13 导出）
- 索引：`legacy-image-index.json`（444 文件：443 manifest + 1 未列出；SHA-256 + 文件头解析尺寸）
- 对账：manifest 443 条全部在盘；封面图匹配 34/34（产品）+ 75/75（文章）= 109/109
- 重复检测：96 文件 SHA-256 重复（页面/staging 共用副本），产品图集顺序无冲突
- 复用率 100%：**零下载**，全部从本地导出复制到 `bailing-backend/uploads/media/2026/10/`
- 映射表：`legacy-image-mapping.csv`（239 行，含源 URL/本地文件/SHA-256/目标 URL/关联/验证状态）

## 四、迁移执行（Phase 5.4.3b）

- 脚本：`prisma/scripts/phase54-migrate-legacy-content.ts`（dry-run 默认、`--apply` 写入、DATABASE_URL 指纹守卫仅允许 bailingwooden 开发库）
- 幂等机制：slug 唯一键（产品/文章/分类/标签）+ 台账 `legacy-migration-ledger.json`（附件 ID→MediaAsset）
- **幂等性实测**：连续 3 次 `--apply`，计数不变（products 34 / product_images 132 / blog_posts 75 / media_assets 239），第 3 次 registered=0、reused=466
- 写入方式：Prisma 事务，复用现有模型；未做任何 schema 变更
- 正文图片 URL 重写：文章 759 处 + 产品描述 53 处（img src / srcset / data-orig|large|medium-file），**站内图 unmatched=0**；38 处外部资源（WP emoji、第三方站 wigwamply.com）按设计保留原 URL 并归类记录
- 旧站 URL 残留复查：产品描述 0、文章正文 0（`LIKE '%bailingwooden.com/wp-content%'`）

## 五、上架规则执行（任务 7.3）

- 代码核查：**当前代码中不存在「产品 4-10 张图」强校验**（仅订单照片 ≤10 张）。按任务声明政策执行并在报告注明
- 18 个产品（图片 4-9 张、描述完整）→ PUBLISHED（源站均为 publish）
- 16 个产品（图片 1-3 张）→ DRAFT，statusReason 逐一记录（如「图片 3 张 < 最少 4 张，按规则不强行上架」），清单见 migration-run-report.json
- 未关闭校验、未伪造图片关系、未重复关联凑数

## 六、验收证据（Phase 5.4.4）

### 6.1 数据库对账（目标实测）

| 表 | 迁移后 |
|---|---:|
| products | 34（18 PUBLISHED / 16 DRAFT） |
| product_images | 132（图集顺序保留、首图 isPrimary） |
| blog_posts | 75（全 PUBLISHED，publishedAt=源站时间） |
| categories | 18（4 seed 保留 + 14 旧站分类） |
| blog_categories / blog_tags / blog_post_tags | 1 / 18 / 18 |
| media_assets | 239 |
| 公开产品 API `/api/v1/products` | total=18（仅 PUBLISHED，草稿不可见，符合规则） |
| 后台 CMS 产品列表（登录态） | total=34 |
| 旧站 URL 残留 | 0 |

### 6.2 图片可访问性

- 抽样 10 个迁移媒体 URL（http://192.168.1.40:4000/uploads/media/2026/10/...）经 `--noproxy` 直连全部 200（初测 502 系系统代理拦截局域网地址所致）

### 6.3 浏览器验收（只读，桌面 1440×900 + 移动端 375×667）

`phase54-browser-acceptance.mjs`：**13/13 PASS**
- 首页 / 产品列表 / 产品详情×2 / 文章列表 / 文章详情：全部 HTTP 200
- 迁移图片加载：产品详情 10/10、14/14；文章详情 6/6；移动端同（无一张加载失败）
- 截图存档：docs/migration/shot-*.png（8 张）
- 验收中发现并修复环境问题：前端 `.next` 被并行会话于 11:54 重建导致旧 `next start` 进程 chunk 400（ChunkLoadError → 错误页）；按项目规范 kill 旧进程树（PID 30704+父 cmd）并以新构建重启 `next start -p 3000`，页面恢复正常。**该故障与迁移内容无关**。

### 6.4 管理端验证

- admin@bailingwooden.com 登录 200（清理前后各验一次）
- CMS 产品/文章列表 API 正常返回迁移数据

## 七、Git 状态与提交情况

- **本阶段未做任何 Git 提交**（任务未明确要求提交；交付文件与脚本均为 untracked 新文件）
- 我新增的 untracked 文件：
  - `bailing-backend/prisma/scripts/phase54-cleanup-mock-data.ts`
  - `bailing-backend/prisma/scripts/phase54-migrate-legacy-content.ts`
  - `bailing-backend/docs/migration/`（全部交付文件 + legacy-raw 抓取数据）
- 未修改任何已跟踪文件；backend/package.json、schema.prisma 等工作区修改系用户原有或另一并行会话（访客统计功能开发）所为，原样保留
- admin 的 RFQ 未提交修改（rfq/page.tsx、lib/rfq.ts、dashboard/page.tsx）开工前后状态一致，未被触碰
- .gitignore 已排除 uploads/（媒体文件不会入库）

## 八、交付文件清单（全部真实落盘）

| 文件 | 说明 |
|---|---|
| docs/migration/phase-5.4-inventory-and-cleanup-report.md | 环境盘点 + 数据库分类 + 备份信息 + 清理前后统计 |
| docs/migration/legacy-content-inventory.json | 旧站完整来源清单（34+75+7，含 SEO/canonical/分类标签 ID） |
| docs/migration/legacy-content-field-mapping.md | 字段映射表（产品/文章/媒体/术语 + 无法映射字段说明） |
| docs/migration/legacy-image-mapping.csv | 239 行图片映射（源 URL/本地文件/SHA-256/目标/关联/验证） |
| docs/migration/phase-5.4-migration-final-report.md | 本报告 |
| docs/migration/legacy-image-index.json + image-index-summary.json | 本地图片索引（SHA-256/尺寸/重复检测） |
| docs/migration/legacy-migration-ledger.json | 迁移台账（附件 ID→媒体、slug→实体 ID） |
| docs/migration/migration-run-report.json | 每次运行逐条记录（含 DRAFT 原因清单） |
| docs/migration/fetch-legacy-content.py / -v2.py / fetch-legacy-terms.py | 旧站只读抓取脚本 |
| docs/migration/build-image-index.py / gen-image-mapping.py | 图片索引与映射生成脚本 |
| docs/migration/phase54-browser-acceptance.mjs | 浏览器验收脚本 + shot-*.png 截图 |
| prisma/scripts/phase54-cleanup-mock-data.ts | 模拟数据清理脚本（幂等） |
| prisma/scripts/phase54-migrate-legacy-content.ts | 迁移主脚本（幂等） |
| D:\bailing-backups-phase54\bailingwooden-pre-cleanup-20261019.dump | 清理前完整备份（SHA-256 已记录） |

## 九、遗留事项与需要用户决定的问题

1. **16 个 DRAFT 产品**：源站图片本来就只有 1-3 张。如需上架需补拍/补图后在后台上传（或用户明确放宽规则后可发布）。
2. **文章 SEO 字段**：posts 的 yoast_head_json 因旧站响应超时未随正文抓取（体积原因）；文章 seoTitle/seoDescription 当前为空。如需补齐，可用轻量请求（`_fields=id,yoast_head_json`）补抓后重跑迁移（幂等，不会重复创建）。
3. **产品 canonical**：Product 模型无 canonicalUrl 列，旧站原始 URL 记录在 inventory 与迁移报告中（文章已有 canonicalUrl）。
4. **E2E 库（bailingwooden_e2e）**：按任务要求未清理（现状：products 3 / admin_users 5 / audit_logs 520），需独立确认后另行处理。
5. **「上架 4-10 张图」校验**：代码中未找到该规则实现，本阶段按任务政策执行。若需在系统层面强制该规则，应在 products 服务/DTO 中补实现（涉及业务代码变更，超出本阶段范围）。
6. **并行会话**：验收期间发现另一会话在开发访客统计功能（visitor_session 迁移、后台 visitor-records 页面、11:54 的 ui 重建），与本阶段文件零交集；前端服务已按其新构建重启。

## 十、合规声明

本阶段**没有部署生产环境**，没有修改旧网站（bailingwooden.com 仅只读 API 访问）、没有修改 DNS、没有修改企业邮箱；未执行任何生产容器/数据库/安全组操作；未触碰 bailingwooden_e2e 与生产数据库；所有写入均限于本地开发库 bailingwooden 且有备份可回滚。
