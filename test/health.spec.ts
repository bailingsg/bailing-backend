import { Test } from '@nestjs/testing';
import { HealthController } from '../src/modules/health/health.controller';
import { HealthService } from '../src/modules/health/health.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { isHealthy: jest.Mock };

  beforeEach(async () => {
    prisma = { isHealthy: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  describe('liveness', () => {
    it('应返回 ok 与运行时长', () => {
      const result = controller.liveness();
      expect(result.status).toBe('ok');
      expect(typeof result.uptime).toBe('number');
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('ready', () => {
    it('数据库可用时应返回 ready', async () => {
      prisma.isHealthy.mockResolvedValue(true);
      const result = await controller.ready();
      expect(result.status).toBe('ready');
      expect(result.checks.database).toBe(true);
    });

    it('数据库不可用时应抛出 ServiceUnavailable', async () => {
      prisma.isHealthy.mockResolvedValue(false);
      await expect(controller.ready()).rejects.toMatchObject({
        status: 503,
      });
    });
  });
});
