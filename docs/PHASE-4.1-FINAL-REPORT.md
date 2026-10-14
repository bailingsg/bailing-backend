# Phase 4.1 Final Report

> 百灵木业 CMS 后台基础架构 + 管理员认证系统 —— 2026-10-14 完成
> 分支：`bailing-backend` / `bailing-admin` 均位于 `261014`（已合入 `dev` 并推送 GitHub）

## A 状态

COMPLETE

后台可登录访问：http://localhost:3001/login（本地管理员账号见 `bailing-backend/.env` 的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`；两个服务当前均在运行：backend 4000 / admin 3001）。

### 完成标准核对

✅ 管理员数据库完成（`admin_users` 随 init 迁移建立，无漂移）
✅ 登录接口完成（`POST /api/v1/auth/login`）
✅ JWT 认证完成（access token 15m，`JwtAuthGuard`）
✅ Admin 登录页面完成（`/login`，HttpOnly Cookie 会话）
✅ Dashboard 完成（真实统计卡片）
✅ 路由保护完成（middleware + 服务端 `/auth/me` 双层）
✅ 不破坏 RFQ 系统（`X-Admin-Token` 通道原样保留，e2e + 运行时双重验证）
✅ 测试通过（后端 35/35，运行时验证 17/17，admin 构建通过）

## B Database

- **模型**：`AdminUser` + `AdminRole{ADMIN, EDITOR}`。经核查，二者已随首个迁移 `20261013114209_init` 建立（Phase 1 已设计），本阶段**无新增迁移**，未触碰任何历史迁移。
- **迁移状态**：`prisma migrate status` = up to date（3 migrations found）。
- **漂移校验**：`prisma migrate diff --from-schema-datasource --to-schema-datamodel --script` 输出 "This is an empty migration" —— **无漂移**。
- **初始管理员**：`prisma/seed.ts` 新增 `seedDefaultAdmin()`——从环境变量 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` 读取（无任何硬编码口令），bcrypt(cost 12) 哈希入库；幂等，口令变更时自动同步（支持轮换）。已执行 seed，库中现存 1 个 ADMIN 账号（哈希前缀 `$2b$12$`，60 字符，确认无明文）。

## C Backend

新增 `src/modules/auth/` 与 `src/modules/cms/`：

| 接口 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /api/v1/auth/login` | 公开 | 邮箱+口令 → `{ accessToken, user }`；失败统一 401 `Invalid email or password` |
| `GET /api/v1/auth/me` | JWT | 当前管理员；以数据库实时状态为准（停用/删除即时失效） |
| `GET /api/v1/cms/stats` | JWT（控制器级） | Dashboard 统计：rfq total/byStatus、products、categories、blogPosts，全部真实计数 |

- **JWT**：`JwtStrategy`（passport-jwt，`Authorization: Bearer` 解析）+ `JwtAuthGuard`（`src/modules/auth/guards/`）。`JWT_SECRET` / `JWT_EXPIRES_IN` 仅来自 `.env`，`env.validation.ts` 强校验（生产缺失或短于 32 字符直接启动失败），代码零默认密钥。
- **仅 access token（15m），未实现 refresh token**——理由：后台为低频操作的内网系统，15 分钟窗口 + HttpOnly Cookie 会话满足安全需求；引入 refresh token 必须配套吊销/黑名单机制，属独立阶段工作（已写入 `docs/API-CONVENTIONS.md` 第 9 节）。
- **RFQ 兼容**：RFQ 三个后台接口维持 `AdminTokenGuard`（`X-Admin-Token`）不变；新增 CMS 接口全部 JWT 保护。两套守卫迁移期并存，互不影响（e2e 已验证公开提交 201 与后台列表行为不变）。
- 依赖备注：`@nestjs/jwt` / `@nestjs/passport` 锁定 v11（v12 为 ESM-only，与本项目 CommonJS 构建冲突）。

## D Admin

- **登录页 `/login`**：Email / Password / Login 按钮（复用 Phase 3.2 Design System）。成功跳 `/dashboard`（含 `next` 回跳）；凭证失败显示 `Invalid email or password`。
- **会话**：同源路由 `POST /api/auth/login` 由服务端转发后端，JWT 写入 **HttpOnly Cookie**（`admin_session`，SameSite=Lax + Secure，Max-Age 900s 与 JWT 有效期一致）。**未使用 localStorage**——localStorage 令牌可被任意 XSS 读取，是令牌泄漏首要途径；HttpOnly Cookie 对 JS 不可见，令牌只在服务端读取并附加 `Authorization` 头转发。
- **路由保护（双层）**：① middleware 拦截 `/dashboard/**` 与 `/rfq/**`（无 Cookie → `/login?next=…`）；② `(dashboard)` 布局用 JWT 调后端 `/auth/me`——伪造/过期/停用令牌在此被拒并回登录页。
- **Dashboard `/dashboard`**：Sidebar + Header + Content 结构；统计卡片（RFQ 总数 / 新询盘 / 产品 / 博客）+ 询盘状态分布 + 内容资产，数据全部来自 `GET /api/v1/cms/stats`，**无虚构数字**；后端不可达时渲染错误态而非崩溃。
- **侧边栏**：Dashboard / Products / Media / Blog / Applications / Factory / Quality / RFQ / Settings——本阶段仅 Dashboard 与 RFQ 可用，其余为不可点击的 Coming Soon。
- 路由调整：根路径 `/` → `/dashboard`；既有 `/rfq` 页面迁入 `(dashboard)` 组，URL 不变。

## E Security

| 项 | 实现 |
| --- | --- |
| 密码 | bcrypt（bcryptjs，cost 12）哈希，库中只存 `passwordHash`；响应统一经 `toAdminProfile` 挑选字段，`passwordHash` 永外泄；登录失败执行同成本占位哈希比较，抹平账号枚举的时间侧信道；失败统一 401 同文案 |
| JWT | 密钥与有效期仅来自环境变量（生产强校验）；仅 access token；`/auth/me` 与未来 CMS 接口以数据库实时状态做二次校验 |
| API | 新 CMS 接口控制器级 `JwtAuthGuard`；RFQ 维持既有 `X-Admin-Token`（兼容） |
| 输入 | `LoginDto`（class-validator：email 格式、password 8–128 长度、email 归一化小写、password 不变换），全局 ValidationPipe（whitelist + forbidNonWhitelisted） |
| 前端持有 | HttpOnly Secure Cookie， SameSite=Lax；浏览器 JS 不接触令牌 |
| 初始化 | 默认管理员仅从 `ADMIN_EMAIL`/`ADMIN_PASSWORD` 环境变量创建，禁止硬编码口令（如 `admin123`） |
| 未做 | 无 RBAC / 权限表 / 用户管理（阶段禁令）；无邮件通知；无文件上传与富文本编辑器 |

## F Tests

| 项目 | 结果 |
| --- | --- |
| Migration status / no drift | PASS |
| Backend lint / typecheck / build | PASS |
| Backend test（35 例：单测 + e2e） | PASS |
| Auth API（login 成功 / 失败×2 / DTO 400） | PASS |
| JWT 保护（无令牌 / 伪造令牌 401） | PASS |
| me endpoint（有效 / 停用 / 删除） | PASS |
| CMS stats（401 + 真实计数核对） | PASS |
| RFQ 兼容（公开 201 / 后台行为不变） | PASS |
| Admin lint / typecheck / 生产 build | PASS |
| Admin Login（成功 / 失败 / 防枚举） | PASS |
| Protected route redirect（未登录 307 + next） | PASS |
| Dashboard 真实数据渲染 | PASS |
| 运行时端到端验证 17/17（`docs/phase-4.1-verify.mjs`） | PASS |

测试明细：`test/auth.spec.ts`（单元 8 例）、`test/auth.e2e-spec.ts`（e2e 11 例），与原 health/rfq/app 套件合计 5 suites / 35 tests 全部通过。

## 阻塞与处置记录

1. **`.env` 口令被工具链脱敏（已解决）**：写入 `.env` 的随机口令在落盘时被替换为 `<SECRET_*>` 占位符，导致初始管理员口令与环境不一致、登录 401。处置：改为运行时生成口令直接写 `.env` 并同步库中 bcrypt 哈希；seed 增加显式 `import 'dotenv/config'`。
2. **GitHub 代理间歇 502（已恢复）**：推送期间代理对 github.com 持续 502，短暂阻塞后恢复，两仓库 `261013` / `261014` / `dev` 全部推送完成（backend dev@`d0e2654`，admin dev@`f478beb`）。
3. **依赖版本冲突（已解决）**：`@nestjs/jwt@12` / `@nestjs/passport@12` 为 ESM-only 与 CommonJS 后端冲突 → 降 v11；`passport-jwt@^4.7` / `bcryptjs@^2.4.31` 不存在 → `^4.0.1` / `^3.0.3`。

## 交付物

- backend：`src/modules/auth/`（controller / service / module / jwt.strategy / guards/jwt-auth.guard / dto / auth.dto / auth.types）、`src/modules/cms/`、配置与 seed 增强、`test/auth.spec.ts` + `test/auth.e2e-spec.ts`、文档（API-CONVENTIONS 第 9 节鉴权规范、README、DEVELOPMENT-LOG）。
- admin：`/login`、`(dashboard)` 路由组（布局 + `/dashboard`）、`api/auth/login|logout` 路由、`middleware.ts`、`lib/session.ts` + `lib/api.ts`、侧边栏与顶栏、README/.env.example。
- 验证脚本：`docs/phase-4.1-verify.mjs`（17 项运行时断言，可重复执行）。

下一步：Phase 4.2 Products CMS 产品内容管理系统开发。
