/**
 * 应用配置集中定义。
 * 禁止在代码中硬编码任何密钥；生产密钥通过环境变量注入。
 */
export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: parseInt(process.env.PORT ?? '4000', 10),
  corsOrigins: process.env.CORS_ORIGINS ?? 'http://localhost:3000',
  logLevel: process.env.LOG_LEVEL ?? 'debug',
});
