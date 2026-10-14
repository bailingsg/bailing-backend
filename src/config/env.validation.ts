import { Logger } from '@nestjs/common';

/**
 * 启动时环境变量校验。
 * 只校验必填项；可选配置（生产占位符）缺失时仅告警。
 * 注意：校验失败信息中不得回显变量值。
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const logger = new Logger('EnvValidation');
  const isProduction = (config.NODE_ENV as string | undefined) === 'production';

  const required = ['DATABASE_URL'];
  const missing = required.filter((key) => !config[key] || String(config[key]).trim() === '');

  if (missing.length > 0) {
    throw new Error(`缺少必填环境变量: ${missing.join(', ')}`);
  }

  const port = Number(config.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('环境变量 PORT 必须是 1-65535 之间的整数');
  }

  // Phase 4.1：JWT 签名密钥。生产环境必须显式注入，禁止代码兜底默认值。
  const jwtSecret = String(config.JWT_SECRET ?? '').trim();
  if (jwtSecret === '') {
    if (isProduction) {
      throw new Error('缺少必填环境变量: JWT_SECRET（生产环境必须注入强随机密钥，禁止使用默认值）');
    }
    logger.warn('JWT_SECRET 未配置：开发环境将使用进程级随机密钥，服务重启后已签发令牌全部失效。');
  } else if (jwtSecret.length < 32) {
    if (isProduction) {
      throw new Error('JWT_SECRET 长度不足：生产环境至少需要 32 个字符的强随机密钥');
    }
    logger.warn('JWT_SECRET 长度不足 32 字符：生产环境必须使用足够长的强随机密钥。');
  }

  // JWT 有效期格式校验（15m / 7d / 3600s 等）
  const jwtExpiresIn = String(config.JWT_EXPIRES_IN ?? '15m').trim();
  if (!/^\d+\s*(ms|s|m|h|d|w|y)$/.test(jwtExpiresIn)) {
    throw new Error('JWT_EXPIRES_IN 格式无效：应形如 15m / 7d / 3600s');
  }

  // 管理员种子提示（不阻断启动：seed 时仍可补配后重跑）
  if (String(config.ADMIN_EMAIL ?? '').trim() === '' || String(config.ADMIN_PASSWORD ?? '').trim() === '') {
    logger.warn('ADMIN_EMAIL / ADMIN_PASSWORD 未配置：prisma seed 将跳过默认管理员创建。');
  }

  logger.log(`环境变量校验通过 (NODE_ENV=${config.NODE_ENV ?? 'development'})`);
  return config;
}
