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

  // Phase 6.0：存储适配器。TENCENT_COS 时配置不完整必须**启动失败**——
  // 绝不静默退化为本地磁盘，否则会出现「上传看似成功、对象却在本地」的误判。
  const storageProvider = String(config.STORAGE_PROVIDER ?? 'LOCAL').trim().toUpperCase();
  if (storageProvider !== 'LOCAL' && storageProvider !== 'TENCENT_COS') {
    throw new Error(
      `STORAGE_PROVIDER 取值无效：${storageProvider}（仅支持 LOCAL / TENCENT_COS）`,
    );
  }
  if (storageProvider === 'TENCENT_COS') {
    const cosKeys = [
      'TENCENT_COS_SECRET_ID',
      'TENCENT_COS_SECRET_KEY',
      'TENCENT_COS_BUCKET',
      'TENCENT_COS_REGION',
      'COS_CDN_DOMAIN',
    ] as const;
    const missingCos = cosKeys.filter((key) => String(config[key] ?? '').trim() === '');
    if (missingCos.length > 0) {
      throw new Error(
        `STORAGE_PROVIDER=TENCENT_COS 但缺少环境变量: ${missingCos.join(', ')}` +
          '（缺失项不会回显具体值；请核对部署环境注入）',
      );
    }
    const cdnDomain = String(config.COS_CDN_DOMAIN ?? '').trim();
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(cdnDomain)) {
      throw new Error('COS_CDN_DOMAIN 必须是不含路径的 https 域名，例如 https://cdn.example.com');
    }
    logger.log(
      `存储适配器: TENCENT_COS（bucket=${String(config.TENCENT_COS_BUCKET)}, region=${String(
        config.TENCENT_COS_REGION,
      )}, cdn=${cdnDomain}）`,
    );
  } else {
    logger.log('存储适配器: LOCAL（本地磁盘）');
  }

  // Phase 4.8：前台内容缓存失效。两者必须同时配置才启用；缺失时仅告警（不阻断启动）。
  const revalidateUrl = String(config.FRONTEND_REVALIDATE_URL ?? '').trim();
  const revalidateSecret = String(config.REVALIDATE_SECRET ?? '').trim();
  if (!revalidateUrl || !revalidateSecret) {
    logger.warn(
      'FRONTEND_REVALIDATE_URL / REVALIDATE_SECRET 未同时配置：CMS 变更后不会主动通知前台失效缓存（前台仍会按 ISR 窗口自然过期）。',
    );
  } else if (revalidateSecret.length < 16) {
    logger.warn('REVALIDATE_SECRET 长度不足 16 字符：生产环境应使用足够长的强随机密钥。');
  }

  // 询盘邮件通知（SMTP）：不完整配置不阻断启动，仅告警降级为「只入库不发信」。
  const smtpKeys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const;
  const missingSmtp = smtpKeys.filter((key) => String(config[key] ?? '').trim() === '');
  if (missingSmtp.length > 0) {
    logger.warn(
      `SMTP 配置不完整（缺 ${missingSmtp.join(', ')}）：询盘将只入库不发送邮件通知。` +
        '（注意：告警不回显任何变量值）',
    );
  } else {
    const smtpPort = Number(config.SMTP_PORT ?? 465);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      throw new Error('环境变量 SMTP_PORT 必须是 1-65535 之间的整数');
    }
    logger.log('SMTP 配置已就绪：询盘将同步发送邮件通知给承接业务员。');
  }

  logger.log(`环境变量校验通过 (NODE_ENV=${config.NODE_ENV ?? 'development'})`);
  return config;
}
