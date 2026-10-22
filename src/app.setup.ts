import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { UPLOAD_ROOT } from './modules/cms/products/upload.options';
import { MEDIA_UPLOAD_ROOT } from './modules/media/media.module';

/**
 * 应用装配：统一前缀、参数校验、异常处理、响应包装、CORS、静态资源。
 * main.ts 与 e2e 测试共用，保证测试覆盖与生产一致的管道行为。
 */
export function setupApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  // 统一 API 前缀，与 docs/API-CONVENTIONS.md 保持一致
  app.setGlobalPrefix('api/v1');

  /*
   * 访客统计：代理信任（访客统计实现规格 4.6）。
   *
   * 线上链路 客户端 → nginx → 后端容器：不信任代理时 req.ip 是 nginx 内网
   * 地址，GeoIP 与限流全部失效。TRUST_PROXY=1 表示信任紧邻一层反代，
   * 按 X-Forwarded-For 回推一跳；'true' 已在 configuration.ts 强制降级为 1
   * （true 允许任意客户端伪造来源 IP，属安全红线）。未配置时不设置。
   */
  const trustProxy = config.get<number | undefined>('trustProxy');
  if (trustProxy !== undefined) {
    (app as unknown as NestExpressApplication).set('trust proxy', trustProxy);
  }

  // 本地图片存储（Phase 4.2）：/uploads/products/** 静态可读。
  // 目录在启动时确保存在；文件写入由 multer 拦截器完成（服务端生成文件名）。
  mkdirSync(UPLOAD_ROOT, { recursive: true });
  (app as unknown as NestExpressApplication).useStaticAssets(UPLOAD_ROOT, {
    prefix: '/uploads',
    maxAge: '7d',
  });

  // 媒体库本地存储（Phase 4.3）：/uploads/media/** 静态可读。
  // MEDIA_UPLOAD_DIR 指向任意目录时仍可解析（默认位于 <cwd>/uploads/media，
  // 已被上面的 /uploads 挂载覆盖，此处显式挂载保证自定义目录同样可用）。
  mkdirSync(MEDIA_UPLOAD_ROOT, { recursive: true });
  (app as unknown as NestExpressApplication).useStaticAssets(MEDIA_UPLOAD_ROOT, {
    prefix: '/uploads/media',
    maxAge: '7d',
  });

  // 全局参数校验：白名单 + 拒绝未声明字段，防止脏数据入库
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // 统一异常处理与统一成功响应结构
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor(new Reflector()));

  /*
   * HTTP 缓存策略（Phase 4.8）—— 全站唯一出口，避免各控制器各写一套。
   *
   * 链路现状：Browser → Next.js（Data Cache + tag，权威缓存层）→ Backend。
   * 本阶段**没有 CDN**，因此这里只声明「浏览器/未来 CDN 可以怎么缓存」，
   * 真正的失效由前台 /api/revalidate（tag / path）负责，两者不冲突：
   *   · 公开只读内容（GET /api/v1/public/**、/products、/categories）
   *     → public, max-age=60, stale-while-revalidate=300（短窗口，可被 CDN 复用）
   *   · 其余（后台 CMS、认证、询盘 RFQ 等）
   *     → no-store（**绝不缓存**：含凭据、内部数据与客户询盘）
   */
  const PUBLIC_READ_RE = /^\/api\/v1\/(?:public\/|products(?:\?|\/|$)|categories(?:\?|\/|$))/;
  app.use((req: { method: string; originalUrl: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    if (!req.originalUrl.startsWith('/api/v1/')) {
      next();
      return;
    }
    if (req.method === 'GET' && PUBLIC_READ_RE.test(req.originalUrl)) {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  // CORS：显式 Origin 白名单，禁止使用 *
  const origins = (config.get<string>('corsOrigins') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
  });
}
