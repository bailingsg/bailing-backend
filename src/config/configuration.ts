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
     *   · JWT_EXPIRES_IN   —— access token 有效期，默认 15m
     *
     * 开发环境未配置 JWT_SECRET 时，生成**进程级随机密钥**（重启后旧令牌全部失效），
     * 仅为方便本地启动，绝不作为生产兜底；生产环境必须显式注入。
     */
    jwtSecret: process.env.JWT_SECRET ?? (isProduction ? '' : randomBytes(48).toString('hex')),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',

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
  };
};
