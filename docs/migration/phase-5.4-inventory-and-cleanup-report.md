# Phase 5.4.1 / 5.4.2 环境盘点与模拟数据清理报告

- 执行时间：2026-10-19 11:11 – 12:00 (GMT+8)
- 执行范围：本地开发环境（无任何生产部署、无旧站/DNS/邮箱变更）
- 目标数据库：本地开发库 `bailingwooden`（PostgreSQL 容器 `bailing-postgres`）

---

## 一、环境盘点（Phase 5.4.1）

### 1.1 仓库与分支状态

| 仓库 | 绝对路径 | 分支 | HEAD | 工作区状态 |
|---|---|---|---|---|
| bailing-backend | D:\com.bailingwooden\bailing-backend | 261017 | 24c1d09 | 有未提交修改：package.json、prisma/schema.prisma、prisma/seed-rbac.ts（M）；新增 prisma/migrations/20261019110000_add_visitor_session_and_daily_statistic/、prisma/scripts/restrict-sales-permissions.ts（??） |
| bailing-ui | D:\com.bailingwooden\bailing-ui | 261017 | 8c78687 | 干净 |
| bailing-admin | D:\com.bailingwooden\bailing-admin | 261017 | 2a983d4 | **用户保留的 RFQ 未提交修改**：src/app/(dashboard)/rfq/page.tsx、src/lib/rfq.ts、src/app/(dashboard)/dashboard/page.tsx |

> RFQ 相关未提交修改已原样保留，本阶段未触碰、未混入任何提交。backend 的未提交修改（访客统计迁移 + 销售权限收敛脚本）同样保持原状。

### 1.2 运行环境（实测核验）

| 服务 | 端口 | 实测状态 | 说明 |
|---|---:|---|---|
| 主网站 bailing-ui | 3000 | 运行中（next start） | — |
| 管理后台 bailing-admin | 3001 | 运行中（next start） | — |
| 后端 API bailing-backend | 4000 | 运行中（node dist/main.js, PID 3680） | 静态图片路由 /uploads/... 实测 200 |
| PostgreSQL | 5432 | 运行中（容器 bailing-postgres, postgres:17-alpine, 127.0.0.1:5432） | healthy |

后端实际连接的数据库经双重验证：
1. 探测请求 `POST /api/v1/auth/login` 后 `pg_stat_activity` 显示 `client_addr=172.20.0.1 → bailingwooden`（idle 连接）；
2. 该请求返回 401 Invalid email or password（证明查询了 admin_users 表）。
结论：**端口 4000 后端使用本地开发库 bailingwooden**。

### 1.3 数据库分类

| 数据库 | 连接目标 | 用途 | 本阶段处理 |
|---|---|---|---|
| bailingwooden | 127.0.0.1:5432（本地容器） | **本地开发库**（后端 4000 实际连接） | 清理与迁移的唯一目标 |
| bailingwooden_e2e | 127.0.0.1:5432（本地容器） | E2E 自动化测试库 | **不清理、不迁移**（任务要求独立确认后方可清理；报告其现状：products 3 / blog_posts 0 / admin_users 5 / audit_logs 520） |
| 生产库 | VPS 43.159.152.116 容器内（bailing-internal 网络，无外网出口） | 生产 | 本阶段完全不连接、不触碰 |

容器内另有 postgres/template0/template1 系统库，无关。

### 1.4 本地图片目录

用户指定目录实测存在：`C:\Users\Administrator\Desktop\bailing-image-export`

- manifest.csv：443 行数据（含表头），字段：本地路径 / 原始URL / 分类 / 归属 slug / 图集顺序 / 附件ID / 图像ALT / 图像Caption / 宽 / 高 / 上传相对路径 / 上传日期 / 出现页面 / 下载状态
- 目录结构：products/（34 个产品文件夹、134 文件）、posts/（53 篇文章文件夹、125 文件）、pages/（4 个页面、66 文件）、site-assets/（103 文件，含 from-staging/）
- 导出时间 2026-10-13，来源为站点公开只读接口（`/wp-json/wp/v2/media` + `/wp-json/wc/store/v1/products`）
- README 明确：下载的是原图；产品图存在跨产品共用；媒体库 407 附件导出 406（1 个非公开）；`sec-title-s-1.webp` 404 未获取；视频未包含

### 1.5 旧站内容源可达性（只读探测）

| 端点 | 结果 |
|---|---|
| GET /wp-json/wp/v2/product | 可用，x-wp-total: **34 个产品** |
| GET /wp-json/wp/v2/posts | 可用，x-wp-total: **75 篇文章** |
| GET /wp-json/wp/v2/pages | 可用，x-wp-total: 7 个页面 |
| GET /wp-json/wc/store/v1/products | 返回空（Store API 未开放产品数据）→ 已改用 wp/v2/product |
| /wp-sitemap.xml | 301 → 跟随后 exit 52（空回复），站点响应极慢期间不可用；以 REST API 全量分页为权威来源，manifest.csv（2026-10-13 导出）作旁证 |

站点整体响应极慢（大分页多次 90–120s 超时、代理间歇 502），抓取采用分页落盘 + 断点续传 + 指数退避（详见 fetch-stats-v2.json）。

### 1.6 备份（清理前执行）

- 命令：`docker exec bailing-postgres pg_dump -U bailing -Fc bailingwooden`
- 文件：`D:\bailing-backups-phase54\bailingwooden-pre-cleanup-20261019.dump`（项目之外独立目录）
- 大小：171,468 字节；生成时间：2026-10-19 11:36 (GMT+8) / 03:36 UTC
- SHA-256：`c09a7f252d28858226229eb6b6094b2ecea76fdb94d200c0404529f5d8c63d6a`（存档于同目录 backup.sha256）
- 验证：`pg_restore -l` 成功解析（318 个 TOC 条目、43 张表含数据），自定义压缩格式完整可读
- 恢复命令（如误操作）：
  ```
  docker exec -i bailing-postgres pg_restore -U bailing -d bailingwooden --clean --if-exists < D:/bailing-backups-phase54/bailingwooden-pre-cleanup-20261019.dump
  ```

---

## 二、模拟数据清理（Phase 5.4.2）

### 2.1 识别依据（逐类证据，非凭时间/用户名猜测）

| 类别 | 识别依据 | 证据 |
|---|---|---|
| 测试账号 ×6 | email 域名 `@bailingwooden.test` | pw-media@ / pw-blog@（Playwright 媒体与博客验收账号）；4 个 e2e-1792110*@（2026-10-16 00:21–00:30 浏览器 E2E 连续创建） |
| demo/playwright 产品 ×5 | slug 前缀 demo-/playwright- | demo-wood-panel / demo-wooden-crate / demo-custom-component（同秒批量创建，seed 演示数据）；playwright-oak-1791958374/8681（DRAFT，Playwright 验收残留，epoch ms 命名） |
| 测试文章 ×1 | **内容本身为垃圾**（非凭时间） | 标题 "20222"、正文仅 `<img alt="">`、唯一文章、2026-10-17 01:54 凌晨创建。脚本内置签名守卫（slug/title 不符即中止） |
| 测试询盘 ×1 | **字段内容为重复数字** + 来源 IP | name "98 Tien"、company "222"、country "22222"、productName "222"、message "22222222222222222222"、quantity "2222"、sourceIp=127.0.0.1（本机表单测试）。脚本内置签名守卫 |
| 测试分类 ×3 | slug 前缀 pw-cat-/e2e-pub- | pw-cat-1791958374/8681（Playwright）；e2e-pub-mvc3c25x-cat「E2E 发布测试分类」（2026-10-17 07:44:18 与测试角色同批次创建） |
| 测试审计日志 ×300 | actorEmail LIKE '%@bailingwooden.test' | 真实操作者 admin@bailingwooden.com（99 条）与 system（61 条）均为 .com 域或空值，不受影响 |
| 测试媒体 ×2 | originalName = e2e-test.png/pdf | 179/192 字节的占位文件 |
| E2E 测试角色 ×1 | key LIKE 'E2E_%' 且无用户绑定、isSystem=false | E2E_PUB_EDITOR_mvc3c25x「E2E 内容编辑（无发布权）」，不在 seed-rbac.ts 预设中，与 e2e-pub-mvc3c25x-cat 同批次创建 |
| 孤儿上传文件 ×50 | 不被任何数据库记录引用 | 47 个 uploads/orders/（orders=0、order_attachments=0，e2e 上传后订单已删）；3 个 uploads/media/ 无 media_assets 记录 |

### 2.2 清理前后统计（实测，本地开发库）

| 表/模块 | 清理前 | 识别为模拟 | 实际删除 | 保留 | 说明 |
|---|---:|---:|---:|---:|---|
| admin_users | 8 | 6 | 6 | 2 | 保留 admin@bailingwooden.com、wangmin@bailingwooden.com |
| admin_user_roles | 8 | 6 | 6 | 2 | 两真实账号各 1 个角色 |
| roles | 4 | 1 | 1 | 3 | SUPER_ADMIN(系统保护)/CONTENT_EDITOR/SALES |
| permissions | 80 | 0 | 0 | 80 | 权限定义行不动 |
| role_permissions | 40 | 3 | 3 | 37 | CONTENT_EDITOR 25 + SALES 12 |
| products | 5 | 5 | 5 | 0 | 3 demo + 2 playwright |
| product_images | 0 | 0 | 0 | 0 | — |
| blog_posts | 1 | 1 | 1 | 0 | 标题 20222 垃圾文章 |
| categories | 7 | 3 | 3 | 4 | 保留 seed.ts 的 4 个基础分类 |
| rfqs | 1 | 1 | 1 | 0 | 重复数字测试询盘 |
| lead_assignments | 1 | 1 | 1 | 0 | 该询盘的 ROUND_ROBIN 自动分配 |
| media_assets | 2 | 2 | 2 | 0 | e2e-test.png/pdf |
| audit_logs | 460 | 300 | 300 | 160 | 保留 admin@ 99 + system 61 |
| content_revisions | 15 | 4 | 4 | 11 | 11 条 SITE_SECTION 修订保留 |
| content_drafts | 0 | 0 | 0 | 0 | — |
| site_sections | 11 | 0 | 0 | 11 | 真实站点内容 |
| nav_items / seo_settings / seo_audit_runs / employee_contacts / lead_round_robin_state | 18/1/5/1/1 | 0 | 0 | 18/1/5/1/1 | 系统配置全保留 |
| uploads/ 文件 | 52 | 50 | 50 | 0 | 5 media + 47 orders 全部为测试残留 |

合计删除数据库记录 **325 行**（6+6+1+3+5+1+1+1+1+2+300+4）、文件 50 个。

### 2.3 执行方式与可审计性

- 脚本：`prisma/scripts/phase54-cleanup-mock-data.ts`（可重复执行、幂等）
- 守卫：启动时校验 `DATABASE_URL` 指纹必须为 `127.0.0.1:5432/bailingwooden?`，否则 BLOCKED 退出——E2E 库与生产库在机制上不可触碰
- 测试文章/询盘设签名守卫（字段不符即中止）
- 删除在单事务内按依赖顺序执行（审计日志→内容修订→线索分配→询盘→产品图→产品→文章→分类→媒体→角色绑定→角色→账号）
- 孤儿文件仅在数据库事务成功提交后回收，逐文件确认存在且无引用
- 先 dry-run 演练（输出完整待删清单），确认无误后才 --apply

### 2.4 清理后验收

- 各表数量如上表「保留」列，与计划一致；无孤立记录（content_drafts=0、planId 非空审计=0、blog_post_tags=0、orders/samples/inventory=0）
- 管理员登录实测：`POST /api/v1/auth/login`（admin@bailingwooden.com）→ 200，返回 SUPER_ADMIN + 80 权限
- 角色/权限/菜单依赖数据完整：3 角色、80 权限、37 条绑定；site_sections 11、nav_items 18、seo_settings 1 均未受影响
- 未清空任何整表，未执行 db push/reset，未触碰 E2E 库与生产库

---

## 三、遗留与说明

1. 代码库中**未找到**「商品上架至少 4 张、最多 10 张图片」校验的实现（仅 `orders.service.ts` 有「订单照片最多 10 张」）。迁移将按任务声明的政策执行：图片 4–10 张且数据完整才可按源状态发布，否则设 DRAFT 并在报告中列出；不以关闭校验或伪造图关系方式上架。
2. E2E 库（bailingwooden_e2e）残留测试数据按任务要求留待独立确认后处理，本阶段未清理。
3. 旧站 sitemap 在站点缓慢期不可用（exit 52），完整性以 REST API 全量分页 + 2026-10-13 导出 manifest 双重核对。
