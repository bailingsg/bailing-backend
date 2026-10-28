import { randomBytes } from 'node:crypto';

/**
 * 应用配置集中定义。
 * 禁止在代码中硬编码任何密钥；生产密钥通过环境变量注入。
 */
export default () => {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    env: process.env.NODE_ENV ?? 'development',
    host: process.env.HOST ?? '0.0.0.0',
    port: parseInt(process.env.PORT ?? '4000', 10),
    corsOrigins: process.env.CORS_ORIGINS ?? 'http://localhost:3000',
    logLevel: process.env.LOG_LEVEL ?? 'debug',
    /**
     * 后台接口共享密钥（保护 RFQ 列表/详情/状态更新，Phase 3.7 兼容机制）。
     * 未配置时后台接口不鉴权（仅本地开发），生产环境必须配置。
     */
    adminApiToken: process.env.ADMIN_API_TOKEN ?? '',

    /**
     * 管理员认证（Phase 4.1）：
     *   · JWT_SECRET       —— 签名密钥，仅来自环境变量；生产环境缺失直接启动失败
     *   · JWT_EXPIRES_IN   —— access token 有效期，默认 12h
     *
     * 开发环境未配置 JWT_SECRET 时，生成**进程级随机密钥**（重启后旧令牌全部失效），
     * 仅为方便本地启动，绝不作为生产兜底；生产环境必须显式注入。
     */
    jwtSecret: process.env.JWT_SECRET ?? (isProduction ? '' : randomBytes(48).toString('hex')),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',

    /**
     * 默认管理员种子（prisma seed 使用）。
     * 仅从环境变量读取，禁止代码硬编码任何默认口令。
     */
    adminSeedEmail: process.env.ADMIN_EMAIL ?? '',
    adminSeedPassword: process.env.ADMIN_PASSWORD ?? '',
    adminSeedName: process.env.ADMIN_NAME ?? 'Administrator',

    /**
     * 产品图片本地存储（Phase 4.2）。
     * uploadsBaseUrl：落库图片 URL 的对外基地址（本地为后端自身；
     * 生产可改为 CDN 域名，如 https://cdn.bailingwooden.com）。
     */
    uploadsBaseUrl:
      process.env.UPLOADS_BASE_URL ??
      `http://127.0.0.1:${process.env.PORT ?? '4000'}`,

    /**
     * 媒体库存储适配器开关（Phase 4.3）。
     *   · LOCAL（默认）：本地磁盘 <cwd>/uploads/media
     *   · TENCENT_COS：腾讯云 COS（预留，未配置前不可用——见 media/storage/cos-storage.provider.ts）
     * 业务代码只依赖 StorageProvider 接口，切换存储无需改业务逻辑。
     */
    storageProvider: process.env.STORAGE_PROVIDER ?? 'LOCAL',

    /**
     * 腾讯云 COS + CDN（Phase 6.0）。
     *
     * 仅在 STORAGE_PROVIDER=TENCENT_COS 时启用；密钥必须是 CAM 子用户
     * （最小权限，仅目标桶对象级读写），禁止使用主账号密钥。
     * 缺失时启动失败并给出明确指引（见 env.validation.ts），绝不静默退化为本地存储。
     *
     *   · cdnDomain     —— 对外访问域名，落库 URL 基地址（换 CDN 只改这一处）
     *   · serviceDomain —— COS 源站域名，仅服务端排障使用，不落库
     */
    cos: {
      secretId: process.env.TENCENT_COS_SECRET_ID ?? '',
      secretKey: process.env.TENCENT_COS_SECRET_KEY ?? '',
      bucket: process.env.TENCENT_COS_BUCKET ?? '',
      region: process.env.TENCENT_COS_REGION ?? '',
      cdnDomain: process.env.COS_CDN_DOMAIN ?? '',
      serviceDomain: process.env.COS_SERVICE_DOMAIN ?? '',
    },

    /**
     * 前台内容缓存失效（Phase 4.8）。
     *
     * CMS 内容发布 / 下架 / 删除后，后端调用前台的安全失效端点
     * （bailing-ui 的 POST /api/revalidate），使前台下一次访问即拿到最新内容，
     * 不再依赖「重建 + 手动清 .next/cache」。
     *
     * 两者**必须同时配置**才启用；任一缺失则自动降级为「不通知」（仅记日志），
     * 保证本地开发 / 测试环境不会因缺少前台而失败。
     */
    frontendRevalidateUrl: process.env.FRONTEND_REVALIDATE_URL ?? '',
    revalidateSecret: process.env.REVALIDATE_SECRET ?? '',

    /**
     * 询盘邮件通知（SMTP）。
     *
     * 访客在前台提交询盘后，后端用这里配置的发件邮箱把询盘内容
     * 发给系统内配置的业务员（承接人），使业务员在常用邮箱里即时收到线索。
     *
     * 四项（HOST / USER / PASSWORD）必须同时配置才启用；任一缺失则自动降级为
     * 「只入库不邮件」（仅记日志），保证本地开发 / 测试环境不会因缺 SMTP 而失败。
     *
     * 安全红线：SMTP_PASSWORD 只从环境变量读取，禁止硬编码、禁止写进日志与响应体。
     */
    smtpHost: process.env.SMTP_HOST ?? '',
    smtpPort: parseInt(process.env.SMTP_PORT ?? '465', 10),
    /** 是否直接使用 TLS 连接（465 = 隐式 TLS；587 = STARTTLS，应为 false） */
    smtpSecure: process.env.SMTP_SECURE ?? 'true',
    smtpUser: process.env.SMTP_USER ?? '',
    smtpPassword: process.env.SMTP_PASSWORD ?? '',
    /** 发件人显示名（163 等服务商要求发件地址必须与 SMTP 账号一致，故地址固定取 smtpUser） */
    mailFromName: process.env.MAIL_FROM_NAME ?? 'Bailing Wooden Website',

    /**
     * 询盘通知收件邮箱（逗号分隔，可选）。
     *
     * 两种作用：
     *   1. 兜底：询盘没有承接人（分配引擎未启用/无员工）时收件人取这里；
     *   2. 抄送：有承接人时作为 CC，便于管理层同时掌握线索。
     * 留空时兜底收件人退化为发件邮箱自身（SMTP_USER）。
     */
    inquiryNotifyEmail: process.env.INQUIRY_NOTIFY_EMAIL ?? '',

    /**
     * 访客统计（匿名流量旁路模块）。
     *
     *   · TRUST_PROXY —— 代理层数。线上链路为 客户端 → nginx → 后端容器，
     *     不配置时 req.ip 会拿到 nginx 内网地址，GeoIP 与限流全部塌成一个值。
     *     线上固定为 1（信任紧邻一层反代）。取值 'true' 一律强制降级为 1 并告警
     *     （true = 信任任意来源的 X-Forwarded-For，任何客户端可伪造来源 IP）。
     *   · VISITOR_AGGREGATION_ENABLED —— 日聚合 worker 开关（默认开）。
     *   · VISITOR_IP_RETENTION_DAYS —— 访客 IP 明细保留天数（默认 30）。
     *     完整 IP 属个人信息，必须有自动删除；清理 worker 按本值每天删除过期行。
     *     调大要谨慎（合规口径 = 最小必要），非法值回退 30。
     *   · VISITOR_IP_CLEANUP_ENABLED —— IP 明细清理 worker 开关（默认开）。
     */
    trustProxy: normalizeTrustProxy(process.env.TRUST_PROXY),
    visitorAggregationEnabled: process.env.VISITOR_AGGREGATION_ENABLED !== 'false',
    visitorIpRetentionDays: normalizeRetentionDays(process.env.VISITOR_IP_RETENTION_DAYS),
    visitorIpCleanupEnabled: process.env.VISITOR_IP_CLEANUP_ENABLED !== 'false',
  };
};

/**
 * TRUST_PROXY 归一化：
 *   · 未设置        → undefined（不调用 app.set，Express 默认不信任代理）
 *   · 数字 n (n>=1) → n
 *   · 'true'        → 强制降级为 1（见 configuration.ts 注释中的安全说明）
 *   · 其它非法值     → undefined（视为未设置）
 */
function normalizeTrustProxy(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'true') {
    // eslint-disable-next-line no-console
    console.warn(
      '[config] TRUST_PROXY=true 不安全（任意客户端可伪造 X-Forwarded-For），已强制降级为 1',
    );
    return 1;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  return undefined;
}

/** 访客 IP 明细保留天数（默认 30，合法区间 1~365） */
export const DEFAULT_VISITOR_IP_RETENTION_DAYS = 30;

/**
 * VISITOR_IP_RETENTION_DAYS 归一化：
 *   · 未设置 / 非法 / 越界 → 30（默认值，不因配错而永不过期）
 *   · 1 ~ 365             → 原值
 *
 * 上限 365 是防呆：写成 36500 等于「永不删除」，与「完整 IP 必须有保留期」
 * 的合规前提冲突，不如直接回退默认值并让人看见 30。
 */
function normalizeRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_VISITOR_IP_RETENTION_DAYS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
    return DEFAULT_VISITOR_IP_RETENTION_DAYS;
  }
  return parsed;
}
