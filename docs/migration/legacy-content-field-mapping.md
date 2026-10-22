# 旧站 → 新站字段映射表（Phase 5.4.3）

- 源：WordPress（bailingwooden.com）REST API `wp/v2/product` / `wp/v2/posts`
- 目标：bailing-backend PostgreSQL（Prisma 模型 `Product` / `BlogPost` / `Category` / `BlogCategory` / `BlogTag` / `MediaAsset`）
- 幂等键：slug（两侧唯一）；媒体按源站附件 ID 记入台账 `legacy-migration-ledger.json`

## 一、产品（wp/v2/product → Product）

| 源字段 | 目标字段 | 转换规则 | 备注 |
|---|---|---|---|
| id | （台账 legacyId） | 记入 ledger.products | 目标库无源站 ID 字段（不做 schema 变更） |
| title.rendered | name | HTML 实体解码（`&#215;`→`×` 等） | — |
| slug | slug | 原样 | 幂等匹配键 |
| content.rendered | description | 原样保留 HTML；img src/srcset/data-*-file 中的旧站 URL 重写为本地媒体 URL | Elementor/块编辑器结构完整保留 |
| excerpt.rendered | shortDescription | 去标签取纯文本，截断 300 字符；空则取正文前 200 字符 | 列表卡片展示用 |
| product_cat[0] | categoryId | 术语 ID→terms-product_cat.json→按 slug upsert `Category` | 源站多分类产品取第一分类为主分类，全部 ID 记入 inventory |
| product_tag[] | applications (Json string[]) | 术语 ID→名称数组 | 目标模型无产品标签表，映射到应用标签字段（已在此记录，无静默丢弃） |
| 正文规格表格 | specifications (Json) | 解析 `<table>` 行 th/td → {key: value} 对象 | 保守解析，仅收录两列以上行；未能入表的规格仍在 description HTML 中完整保留 |
| 规格中的 Material 行 | material | 从 specifications 提取 | 无则空 |
| yoast_head_json.title | seoTitle | 剥离站点后缀「 - Shouguang Bailing Wood Industry \| MDF, Plywood & Decorative Materials」 | — |
| yoast_head_json.description | seoDescription | 原样 | — |
| yoast_head_json.canonical / link | （canonicalUrl） | 产品模型无 canonical 字段；canonical 记入迁移报告与 inventory，未静默丢弃 | Product 模型无该列 |
| featured_media | ProductImage[0]（isPrimary=true） | 附件 ID→MediaAsset→URL；经图集顺序核验 order-0 == featured（34/34 一致） | — |
| 附件ID（图集，manifest） | ProductImage[]（按图集顺序排序） | 每附件一个 MediaAsset（跨产品共用图仅注册一次）+ ProductImage{url, altText, sortOrder, isPrimary} | ALT 来自 manifest 图像ALT |
| status（publish） | status | 见发布策略 | 34/34 源站均为 publish |
| date / modified | createdAt / updatedAt | 原样写入 | — |
| — | version=1, publishedVersion | PUBLISHED→1；DRAFT→0 | 与发布引擎 draft 语义一致 |

### 产品发布策略（任务 7.3）

- 图片 4–10 张且描述非空且分类可解析 → PUBLISHED
- 图片 <4 张（16 个产品）→ DRAFT，statusReason 记录「图片 N 张 < 最少 4 张，按规则不强行上架」
- 图片 >10 张 → DRAFT（本次无此情况，pet-mdf 9 张为最多）
- 未关闭任何校验、未伪造图片关系

## 二、文章（wp/v2/posts → BlogPost）

| 源字段 | 目标字段 | 转换规则 | 备注 |
|---|---|---|---|
| id | （台账 legacyId） | 记入 ledger.posts | — |
| title.rendered | title | HTML 实体解码 | — |
| slug | slug | 原样 | 幂等匹配键 |
| content.rendered | content | 原样保留（Elementor HTML 53KB/篇级别）；img src/srcset/data-*-file 旧站 URL 重写为本地媒体 URL；第三方外链图（wigwamply.com、s.w.org emoji）保留原 URL 并计入 externalIgnored | 共重写 477+ 处内嵌/灯箱引用 |
| excerpt.rendered | excerpt | 去标签截断 500 字符 | — |
| featured_media | coverImageUrl + coverMediaId | 附件 ID→MediaAsset（75/75 全部命中本地导出） | — |
| categories[0] | categoryId | 术语 ID→terms-categories.json→按 slug upsert `BlogCategory` | 源站全部文章同属 1 个分类 |
| tags[] | BlogTag + blog_post_tags | 术语 ID→按 slug upsert | — |
| status（publish） | status | publish 且正文非空 → PUBLISHED（75/75） | — |
| date | publishedAt + createdAt | 原样 | — |
| modified | updatedAt | 原样 | — |
| author（数字 ID） | （不映射） | 公开 API 无法解析作者姓名；源站 author ID 记入 inventory；目标 authorId=null | 无作者信息丢失风险（正文不含作者署名字段） |
| yoast_head_json | seoTitle/seoDescription | posts 的 _fields 抓取未含 yoast（响应体过大超时），posts 的 SEO 字段为空 | 已知限制，见最终报告遗留事项；canonical 用 link 记入 canonicalUrl |
| link | canonicalUrl | 原始 URL 可追溯 | — |

## 三、媒体（wp/v2/media 附件 → MediaAsset）

| 源 | 目标 | 规则 |
|---|---|---|
| 附件 ID | ledger.attachments[id].mediaAssetId | 幂等复用键 |
| 本地导出文件（Desktop/bailing-image-export） | uploads/media/2026/10/<uuid>.<ext> | 复制原图（webp 等），不入 Git |
| — | filename | 服务端生成 UUID 文件名（符合 LocalStorageProvider 白名单） |
| manifest 本地路径文件名 | originalName | 保留原始文件名 |
| manifest 图像ALT / 图像Caption | altText / caption | 原样 |
| manifest 宽 / 高 | width / height | 文件头解析值 |
| URL 规则 | url | `UPLOADS_BASE_URL(http://192.168.1.40:4000)/uploads/<storageKey>`（与既有媒体机制一致） |

## 四、术语

| 源端点 | 目标模型 | 数量 |
|---|---|---:|
| wp/v2/product_cat | Category（slug 冲突时复用既有行） | 15（14 使用 + uncategorized） |
| wp/v2/product_tag | Product.applications（名称数组） | 15 |
| wp/v2/categories | BlogCategory | 1 |
| wp/v2/tags | BlogTag | 18 |

## 五、无法映射/有意不映射的字段（无静默丢弃）

| 源字段 | 处理 |
|---|---|
| product yoast canonical | 记入 inventory + 迁移报告（目标模型无该列） |
| post yoast SEO（title/description） | 未抓取（体积原因），列入遗留事项 |
| post author ID | 记入 inventory |
| WooCommerce SKU/价格/库存 | 公开 API 不暴露（需鉴权），旧站页面亦未展示价格；如需后续补录需登录旧站后台 |
| Elementor 页面结构（pages 端点 7 个页面） | 任务范围为产品与文章，仅盘点不迁移 |
| 视频资源（/video/ 页 6 个 mp4 外链） | 非图片非文章内容，README 已注明另行处理 |
