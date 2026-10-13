# API 规范（API Conventions）

> 本文档是 bailingsg 三仓库之间唯一的 API 契约源。后端实现必须遵守；前端仅可依据本文档调用 API。

## 1. 基础约定

- 基地址：本地开发 `http://127.0.0.1:4000`（或 `localhost:4000`）；未来生产 `https://api.bailingwooden.com`。
- 全局前缀：`/api/v1`。新增资源一律挂在该前缀下。
- 传输格式：JSON（`Content-Type: application/json`）。
- 时间格式：ISO 8601 UTC（如 `2026-10-13T03:33:35.882Z`）。

## 2. 统一响应结构

### 成功（经 `TransformInterceptor` 包装）

```json
{
  "success": true,
  "data": { "status": "ok" }
}
```

### 失败（经 `HttpExceptionFilter` 包装）

```json
{
  "success": false,
  "error": {
    "code": 400,
    "message": "Validation failed",
    "details": { "validationErrors": ["email must be an email"] }
  }
}
```

- `code`：HTTP 状态码；预留业务错误码（数字/字符串）扩展位。
- `message`：面向客户端的安全文案，**禁止**包含堆栈、SQL、连接串、密钥。
- `details`：可选，如 class-validator 校验明细数组。
- 未捕获异常统一返回 `500` + `"Internal server error"`，真实堆栈只进服务端日志。

## 3. 状态码使用

| 状态码 | 场景 |
| --- | --- |
| 200 | 查询成功 |
| 201 | 创建成功（Phase 2+） |
| 400 | 参数校验失败（ValidationPipe） |
| 404 | 路由不存在 / 资源不存在 |
| 409 | 唯一约束冲突（Phase 2+） |
| 500 | 未预期服务端错误 |
| 503 | 服务未就绪（当前用于 `/health/ready` 数据库不可用） |

## 4. 参数校验

- 全局 `ValidationPipe`：`whitelist: true`（剥离未声明字段）、`forbidNonWhitelisted: true`（存在未知字段直接 400）、自动 `transform`。
- DTO 使用 `class-validator` 装饰器；入参类型集中在 `*.dto.ts`，与 Controller 分离。
- Controller 保持“薄”：只做协议适配；业务逻辑在 Service；数据访问只允许经过 PrismaService。

## 5. CORS

- 后端 `CORS_ORIGINS` 显式白名单（逗号分隔），当前开发值：`http://localhost:3000,http://127.0.0.1:3000`。
- **禁止 `*`**；生产环境必须显式列出站点域名。
- 允许方法：`GET, POST, PUT, PATCH, DELETE, OPTIONS`；允许头：`Content-Type, Authorization`。

## 6. 健康检查端点

| 端点 | 语义 | 依赖 | 失败语义 |
| --- | --- | --- | --- |
| `GET /api/v1/health` | 存活（liveness） | 无 | 进程挂了自然不可达 |
| `GET /api/v1/health/ready` | 就绪（readiness） | 数据库 `SELECT 1` | 返回 `503` + 统一错误结构 |

设计意图：数据库抖动时，`/health` 仍可探测（进程健康），`/ready` 失败（负载均衡据此摘除节点）——两者分离是后续容器化部署的基础。

## 7. 版本演进

- 破坏性变更：升 `/api/v2`，旧版保留一个弃用周期；或在响应头声明弃用。
- 新增字段：只能追加（老客户端忽略未知字段，配合 `whitelist` 语义注意双向兼容）。
- 任何 API 行为变更必须同步更新本文档与 `docs/DEVELOPMENT-LOG.md`。

## 8. 当前端点清单（Phase 1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/health` | 存活检查 |
| GET | `/api/v1/health/ready` | 就绪检查（含数据库） |

Phase 2 起新增：产品分类/详情、询盘提交（`POST /api/v1/inquiries`，需 DTO 校验 + 限流）等。

## 9. 鉴权（Phase 2 预留）

管理后台接口将使用 Bearer Token（JWT 方案待 Phase 2 定稿）；届时在本文档补充令牌刷新、越权防护与速率限制约定。本阶段无任何鉴权端点。
