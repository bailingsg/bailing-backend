# bailingwoods.com 内容迁移报告

- 源站：`http://www.bailingwoods.com/`（第二旧站，ASP.NET 静态站，仅 HTTP 可达；WAF 会拦截 `sitemap.xml` 与裸 UA 请求）
- 目标：本地开发库 `bailingwooden`（新站），**全部通过 CMS API 写入**，未直接改库
- 执行时间：2026-10-22
- 脚本：`prisma/scripts/import-bailingwoods-products.mjs`（默认 dry-run，`--apply` 落库，slug 幂等）

## 1. 源站内容盘点（结论：内容极薄）

| 栏目 | URL 形态 | 实际内容 |
| --- | --- | --- |
| 产品 | `/en/product_detail-{cat}-35-{id}.html` | **15 个**，全部为「标题 + 图片集」，正文**零文字**（唯一文字就是产品名） |
| 新闻 | `/en/news_detail-20-36-{id}.html` | **4 篇**，标题为 Our promise / company culture / Quality Assurance / Our Vision，正文容器**全空** |
| 其它 | `/en/about-16-*`、`job-37-*`、`message-47-*` | 公司简介 / 招聘 / 留言，无文章属性 |

产品分类（9 个）：FILM FACED PLYWOOD、PLYWOOD、MDF、OSB、HOLLOW CHIPBOARD、PARTICLE BOARD、HARDBOARD 等，均为单一层级。

## 2. 查重结果（对照新站已有 34 个产品）

| 判定 | 数量 | 明细 |
| --- | --- | --- |
| 严格重名 | 5 | Film Faced Plywood ×2（源站自重复）、Melamine MDF、Fireproof MDF、Melamine Particle Board |
| 语义近重复 | 5 | HMR MDF Board≈HMR MDF、Hardboard≈Hard Board、OSB≈Oriented Strand Board、Raw MDF Board≈Plain MDF、Hollow Chipboard≈Hollow Particle Board |
| **真正新增** | **5** | Pine Plywood、Teak Plywood、Okoume Plywood、Ash Veneer MDF、Particle Board / Chipboard |

## 3. 迁移结果（5 个产品，全部 DRAFT）

| 产品 | slug | 分类 | 图片 | 正文字符 | 产品 ID |
| --- | --- | --- | --- | --- | --- |
| Pine Plywood | pine-plywood | plywood | 6 | 4552 | cmviuzwfj0011pub0q6mmvccc |
| Teak Plywood | teak-plywood | plywood | 1 | 3834 | cmviuyvab000opub0mkbkay7i |
| Okoume Plywood | okoume-plywood | plywood | 1 | 3846 | cmviuyw4x000rpub0axuo7u43 |
| Ash Veneer MDF | ash-veneer-mdf | mdf | 7 | 4100 | cmviuzy41001apub0wf36hv8e |
| Particle Board / Chipboard | particle-board-chipboard | particle-board | 6 | 4511 | cmviv009s001ipub0999793m7 |

- 图片：21 张全部从源站下载后**回传新站媒体库**（不热链第三方），正文以 `<img alt loading="lazy">` 追加在末尾；实测首图 200 / image/jpeg。
- 正文：按指示复制同品类现有产品正文为基底（Pine/Teak/Okoume ← Commercial Plywood；Ash Veneer MDF ← Plain MDF；Particle Board ← Melamine Particle Board），**产品名全量替换**，顶部补一句由产品名可推出的事实描述，`shortDescription` 取该句（46–71 字符，≤100 上限）。
- 状态：**全部 DRAFT**（前台公开接口实测 404，未泄漏）。
- 重存安全：5 篇 description 过 `sanitizeRichText` 往返**全部 IDENTICAL**，后台再次保存不会破坏内容。

## 4. 未迁移项与原因

1. **4 篇「文章」**：正文为空壳（公司文化页），按确认结论跳过。
2. **10 个重复/近重复产品**：新站已有更完整版本（含正文与规格表），重复迁入只会产生重复内容；如需并入，可复用脚本追加 JOBS 条目，slug 自动避让。

## 5. 执行中遇到的问题

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| 图片上传 400「文件内容与声明格式不符」 | 根相对路径 `/uploadfile/...` 被错误解析到 `/en/uploadfile/...`，WAF 返回 39 字节中文提示页 | 修正 `absUrl()`：根相对路径按域名解析，`../` 交给 `new URL`；重跑后 21 张全部成功 |
| `sitemap.xml` 返回「您提交的Get数据有恶意字符」 | 源站 WAF 拦截 | 改为从列表页抓取（`product-35-0-{cat}.html` × 9 分类） |

## 6. 后续建议

- 5 个产品正文为「模板复用」文案，上架前需人工核对事实（尤其 Particle Board / Chipboard 借用了 Melamine Particle Board 的描述，含贴面相关表述）。
- Teak / Okoume 各仅 1 张图，低于「上架 ≥4 图」的既有约定，建议补图后再发布。
- 若需上线，走后台「发布」或 `POST /cms/products/:id/publish`，并记得 `POST /api/revalidate` 刷新前台缓存。
