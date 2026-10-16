import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ProductStatus, RfqStatus } from '@prisma/client';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AdminTokenGuard } from '../src/modules/rfq/admin-token.guard';
import { RfqController } from '../src/modules/rfq/rfq.controller';
import { RfqService } from '../src/modules/rfq/rfq.service';

/** 构造一条 RFQ 记录（模拟 Prisma 返回） */
function makeRfq(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date('2026-10-14T00:00:00.000Z');
  return {
    id: 'rfq_1',
    name: 'John Buyer',
    company: 'Buyer Ltd',
    email: 'john@buyer.com',
    phone: null,
    country: 'United States',
    productId: null,
    productName: null,
    message: 'Please quote 500 units of the wooden panel.',
    quantity: null,
    attachmentUrl: null,
    status: RfqStatus.NEW,
    sourceIp: null,
    userAgent: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const validDto = {
  name: 'John Buyer',
  company: 'Buyer Ltd',
  email: 'john@buyer.com',
  country: 'United States',
  message: 'Please quote 500 units of the wooden panel.',
};

describe('RfqService', () => {
  let service: RfqService;
  let prisma: {
    rfq: { create: jest.Mock; count: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    product: { findFirst: jest.Mock };
    leadAssignment: { create: jest.Mock; findFirst: jest.Mock };
    leadRoundRobinState: { upsert: jest.Mock };
    leadDistributionItem: { update: jest.Mock; findMany: jest.Mock };
    adminUser: { findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      rfq: {
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      product: { findFirst: jest.fn() },
      leadAssignment: { create: jest.fn(), findFirst: jest.fn() },
      leadRoundRobinState: { upsert: jest.fn() },
      leadDistributionItem: { update: jest.fn(), findMany: jest.fn() },
      adminUser: { findUniqueOrThrow: jest.fn() },
      // 数组形式（批量）与回调形式（交互式事务）都要支持：
      // RfqService.create 自 Phase 4.6 起用回调式事务包裹「建询盘 + 自动分配」。
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [RfqController],
      providers: [
        RfqService,
        AdminTokenGuard,
        { provide: PrismaService, useValue: prisma },
        // 未配置 ADMIN_API_TOKEN → 后台接口在本地开发放行
        { provide: ConfigService, useValue: { get: () => '' } },
      ],
    }).compile();

    service = moduleRef.get(RfqService);
  });

  describe('create', () => {
    it('应保存询盘并返回最小回执（不含隐私字段）', async () => {
      prisma.rfq.create.mockResolvedValue(makeRfq());

      const receipt = await service.create(validDto);

      expect(prisma.rfq.create).toHaveBeenCalledTimes(1);
      expect(receipt).toEqual({
        id: 'rfq_1',
        status: RfqStatus.NEW,
        createdAt: '2026-10-14T00:00:00.000Z',
      });
      // 回执不得包含客户邮箱等隐私字段
      expect(receipt).not.toHaveProperty('email');
      expect(receipt).not.toHaveProperty('message');
    });

    it('传入有效 productId 时应快照已发布产品名称', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'prod_1', name: 'Wood Panel' });
      prisma.rfq.create.mockResolvedValue(makeRfq({ productId: 'prod_1', productName: 'Wood Panel' }));

      await service.create({ ...validDto, productId: 'prod_1' });

      expect(prisma.product.findFirst).toHaveBeenCalledWith({
        where: { id: 'prod_1', status: ProductStatus.PUBLISHED },
        select: { id: true, name: true },
      });
      expect(prisma.rfq.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: 'prod_1', productName: 'Wood Panel' }) }),
      );
    });

    it('productId 无效时应丢弃关联但不拒绝提交', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.rfq.create.mockResolvedValue(makeRfq());

      await service.create({ ...validDto, productId: 'ghost' });

      expect(prisma.rfq.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: null, productName: null }) }),
      );
    });

    it('应记录来源 IP 与 UA（风控字段）', async () => {
      prisma.rfq.create.mockResolvedValue(makeRfq());

      await service.create(validDto, { sourceIp: '1.2.3.4', userAgent: 'jest' });

      expect(prisma.rfq.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sourceIp: '1.2.3.4', userAgent: 'jest' }) }),
      );
    });
  });

  describe('list', () => {
    it('应返回分页信封并按状态过滤', async () => {
      prisma.rfq.count.mockResolvedValue(1);
      prisma.rfq.findMany.mockResolvedValue([makeRfq()]);

      const result = await service.list({ page: 2, pageSize: 10, status: RfqStatus.NEW });

      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.totalPages).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(prisma.rfq.count).toHaveBeenCalledWith({ where: { status: RfqStatus.NEW } });
    });

    it('pageSize 超过上限时应被裁剪', async () => {
      prisma.rfq.count.mockResolvedValue(0);
      prisma.rfq.findMany.mockResolvedValue([]);

      const result = await service.list({ pageSize: 9999 });

      expect(result.pageSize).toBe(100);
    });
  });

  describe('findById', () => {
    it('不存在时应抛出 404', async () => {
      prisma.rfq.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('存在时应返回详情（含 message）', async () => {
      prisma.rfq.findUnique.mockResolvedValue(makeRfq());
      const detail = await service.findById('rfq_1');
      expect(detail.message).toContain('wooden panel');
    });
  });

  describe('updateStatus', () => {
    it('不存在时应抛出 404', async () => {
      prisma.rfq.findUnique.mockResolvedValue(null);
      await expect(service.updateStatus('missing', RfqStatus.CONTACTED)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('应将状态从 NEW 流转为 CONTACTED', async () => {
      prisma.rfq.findUnique.mockResolvedValue({ id: 'rfq_1' });
      prisma.rfq.update.mockResolvedValue(makeRfq({ status: RfqStatus.CONTACTED }));

      const detail = await service.updateStatus('rfq_1', RfqStatus.CONTACTED);

      expect(detail.status).toBe(RfqStatus.CONTACTED);
      // Phase 4.6 起响应带出承接人关联（include），故用 objectContaining 断言
      expect(prisma.rfq.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rfq_1' },
          data: { status: RfqStatus.CONTACTED },
        }),
      );
    });
  });
});
