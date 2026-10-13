import { Logger } from '@nestjs/common';

/**
 * 启动时环境变量校验。
 * 只校验必填项；可选配置（生产占位符）缺失时仅告警。
 * 注意：校验失败信息中不得回显变量值。
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const logger = new Logger('EnvValidation');
  const required = ['DATABASE_URL'];
  const missing = required.filter((key) => !config[key] || String(config[key]).trim() === '');

  if (missing.length > 0) {
    throw new Error(`缺少必填环境变量: ${missing.join(', ')}`);
  }

  const port = Number(config.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('环境变量 PORT 必须是 1-65535 之间的整数');
  }

  logger.log(`环境变量校验通过 (NODE_ENV=${config.NODE_ENV ?? 'development'})`);
  return config;
}
