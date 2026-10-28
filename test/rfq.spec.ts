import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ProductStatus, RfqStatus } from '@prisma/client';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { RbacService } from '../src/modules/rbac/rbac.service';
import { RfqAuthGuard } from '../src/modules/rfq/rfq-auth.guard';
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
    employeeContact: { findFirst: jest.Mock };
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
      employeeContact: { findFirst: jest.fn() },
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
        // 控制器声明了 RfqAuthGuard：这里提供最小依赖桩，本文件只测 service 逻辑
        RfqAuthGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: RbacService, useValue: { resolveAccess: jest.fn(), satisfies: jest.fn() } },
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },
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

  describe('直发模式（Sales Contacts 指定销售员）', () => {
    beforeEach(() => {
      // 默认解析不到直发收件人（其余用例走原轮询路径）
      prisma.employeeContact.findFirst.mockResolvedValue(null);
    });

    it('directEmail 命中已公开销售时应直接归属且不调用分配引擎', async () => {
      prisma.employeeContact.findFirst.mockResolvedValue({
        adminUserId: 'admin_1',
        displayEmail: 'sales@bailingwooden.com',
      });
      prisma.rfq.create.mockResolvedValue(makeRfq({ assigneeId: 'admin_1' }));

      await service.create({ ...validDto, directEmail: 'sales@bailingwooden.com' });

      expect(prisma.employeeContact.findFirst).toHaveBeenCalledWith({
        where: {
          displayEmail: { equals: 'sales@bailingwooden.com', mode: 'insensitive' },
          showOnSite: true,
          adminUser: { isActive: true },
        },
        select: { adminUserId: true, displayEmail: true },
      });
      // 入库即归属：不经过分配引擎，轮询指针 / 倾斜计划完全不被触碰
      expect(prisma.rfq.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assigneeId: 'admin_1',
            assignedAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.leadAssignment.create).not.toHaveBeenCalled();
      expect(prisma.leadRoundRobinState.upsert).not.toHaveBeenCalled();
    });

    it('directEmail 不是已公开联系人时应静默回落到正常轮询', async () => {
      prisma.rfq.create.mockResolvedValue(makeRfq());

      await service.create({ ...validDto, directEmail: 'stranger@evil.com' });

      expect(prisma.rfq.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ assigneeId: expect.anything() }),
        }),
      );
      // 线索优先：仍然入库（create 被调用），分配引擎照常工作
      expect(prisma.rfq.create).toHaveBeenCalledTimes(1);
      expect(prisma.leadAssignment.create).not.toHaveBeenCalled();
      expect(prisma.leadRoundRobinState.upsert).not.toHaveBeenCalled();
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

  /**
   * 数据隔离（2026-10-28）：业务 / 销售账号只能看到「分配给本人」的询盘。
   * 超管与服务身份（actor 为空）保持全局可见。
   */
  describe('数据隔离', () => {
    const salesActor = {
      id: 'user_sales_1',
      email: 'sales1@bailingwoods.com',
      name: 'Sales One',
      permissions: new Set(['rfq.read', 'rfq.update']),
      isSuperAdmin: false,
    };
    const superActor = { ...salesActor, id: 'user_admin', isSuperAdmin: true };

    it('业务账号的列表查询应强制按本人承接过滤', async () => {
      prisma.rfq.count.mockResolvedValue(0);
      prisma.rfq.findMany.mockResolvedValue([]);

      await service.list({ status: RfqStatus.NEW }, salesActor);

      expect(prisma.rfq.count).toHaveBeenCalledWith({
        where: { assigneeId: 'user_sales_1', status: RfqStatus.NEW },
      });
    });

    it('业务账号传入他人 assigneeId 时应被忽略（仍只看自己）', async () => {
      prisma.rfq.count.mockResolvedValue(0);
      prisma.rfq.findMany.mockResolvedValue([]);

      await service.list({ assigneeId: 'user_other' }, salesActor);

      expect(prisma.rfq.count).toHaveBeenCalledWith({ where: { assigneeId: 'user_sales_1' } });
    });

    it('超级管理员可按承接人筛选全部询盘', async () => {
      prisma.rfq.count.mockResolvedValue(0);
      prisma.rfq.findMany.mockResolvedValue([]);

      await service.list({ assigneeId: 'user_sales_1' }, superActor);

      expect(prisma.rfq.count).toHaveBeenCalledWith({ where: { assigneeId: 'user_sales_1' } });
    });

    it('服务身份（无 actor）保持全局可见', async () => {
      prisma.rfq.count.mockResolvedValue(0);
      prisma.rfq.findMany.mockResolvedValue([]);

      await service.list({});

      expect(prisma.rfq.count).toHaveBeenCalledWith({ where: {} });
    });

    it('业务账号访问他人询盘详情应返回 404（不泄漏存在性）', async () => {
      prisma.rfq.findUnique.mockResolvedValue(makeRfq({ assigneeId: 'user_other' }));

      await expect(service.findById('rfq_1', salesActor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('业务账号可访问分配给自己的询盘详情', async () => {
      prisma.rfq.findUnique.mockResolvedValue(makeRfq({ assigneeId: 'user_sales_1' }));

      const detail = await service.findById('rfq_1', salesActor);

      expect(detail.id).toBe('rfq_1');
    });

    it('业务账号不能流转他人询盘的状态', async () => {
      prisma.rfq.findUnique.mockResolvedValue({ id: 'rfq_1', assigneeId: 'user_other' });

      await expect(
        service.updateStatus('rfq_1', RfqStatus.CONTACTED, salesActor),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.rfq.update).not.toHaveBeenCalled();
    });

    it('业务账号不能补发他人询盘的通知邮件', async () => {
      prisma.rfq.findUnique.mockResolvedValue({ id: 'rfq_1', assigneeId: 'user_other' });

      await expect(service.resendNotification('rfq_1', salesActor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
