import { Test } from '@nestjs/testing';
import { RfqStatus } from '@prisma/client';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { CmsService } from '../src/modules/cms/cms.service';
import type { ActorContext } from '../src/modules/rbac/actor-context';

/**
 * Dashboard 统计的询盘口径隔离（2026-10-28）。
 *
 * 业务 / 销售账号在「业务概览」里只能看到**分配给本人**的询盘数量，
 * 不允许看到全局数字；超级管理员与服务身份保持全局统计。
 */
describe('CmsService.getStats 询盘口径隔离', () => {
  let service: CmsService;
  let prisma: {
    rfq: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    category: { count: jest.Mock };
    blogPost: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const salesActor: ActorContext = {
    id: 'user_sales_1',
    email: 'sales1@bailingwoods.com',
    name: 'Sales One',
    permissions: new Set(['dashboard.read', 'rfq.read']),
    isSuperAdmin: false,
  };

  beforeEach(async () => {
    prisma = {
      rfq: { findMany: jest.fn().mockResolvedValue([{ status: RfqStatus.NEW }]) },
      product: { findMany: jest.fn().mockResolvedValue([{ status: 'PUBLISHED' }]) },
      category: { count: jest.fn().mockResolvedValue(3) },
      blogPost: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((arg: unknown) => Promise.all(arg as Promise<unknown>[])),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [CmsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(CmsService);
  });

  it('业务账号只统计分配给本人的询盘', async () => {
    const stats = await service.getStats(salesActor);

    expect(prisma.rfq.findMany).toHaveBeenCalledWith({
      where: { assigneeId: 'user_sales_1' },
      select: { status: true },
    });
    expect(stats.rfq.total).toBe(1);
    expect(stats.rfq.byStatus.NEW).toBe(1);
  });

  it('超级管理员统计全局询盘', async () => {
    await service.getStats({ ...salesActor, id: 'user_admin', isSuperAdmin: true });

    expect(prisma.rfq.findMany).toHaveBeenCalledWith({
      where: {},
      select: { status: true },
    });
  });

  it('服务身份（无 actor）保持全局统计', async () => {
    await service.getStats();

    expect(prisma.rfq.findMany).toHaveBeenCalledWith({
      where: {},
      select: { status: true },
    });
  });
});
