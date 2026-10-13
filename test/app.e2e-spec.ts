import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';

/**
 * 端到端冒烟测试。
 * 依赖本地 Docker PostgreSQL 已启动（npm run db:up）；
 * 若数据库未启动，/health/ready 应返回 503，本测试同样视为通过（验证了错误路径）。
 */
describe('Health endpoints (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health 应返回 200 与统一结构', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/v1/health/ready 应返回 200 或 503，且结构统一', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body.data.checks.database).toBe(true);
      expect(res.body.data.status).toBe('ready');
    } else {
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(503);
    }
  });

  it('未知路径应返回 404 统一错误结构', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/not-exist').expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(404);
  });
});
