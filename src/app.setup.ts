import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { UPLOAD_ROOT } from './modules/cms/products/upload.options';

/**
 * 应用装配：统一前缀、参数校验、异常处理、响应包装、CORS、静态资源。
 * main.ts 与 e2e 测试共用，保证测试覆盖与生产一致的管道行为。
 */
export function setupApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  // 统一 API 前缀，与 docs/API-CONVENTIONS.md 保持一致
  app.setGlobalPrefix('api/v1');

  // 本地图片存储（Phase 4.2）：/uploads/products/** 静态可读。
  // 目录在启动时确保存在；文件写入由 multer 拦截器完成（服务端生成文件名）。
  mkdirSync(UPLOAD_ROOT, { recursive: true });
  (app as unknown as NestExpressApplication).useStaticAssets(UPLOAD_ROOT, {
    prefix: '/uploads',
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
  app.useGlobalInterceptors(new TransformInterceptor());

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
