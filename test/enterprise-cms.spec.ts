import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ContentStatus, FactorySectionType, QualityRecordType } from '@prisma/client';
import { FactorySectionsService } from '../src/modules/cms/factory/factory-sections.service';
import { QualityRecordsService } from '../src/modules/cms/quality/quality-records.service';
import { ApplicationsService } from '../src/modules/cms/applications/applications.service';
import type { PrismaService } from '../src/modules/prisma/prisma.service';
import { makeRevalidationMock } from './helpers/revalidation-mock';

/**
 * Enterprise CMS 单元测试（Phase 4.5：Factory / Quality / Applications）。
 *
 * 覆盖任务书要求：
 *   · Factory：CRUD、排序、状态、封面/图库/展会媒体存在性校验、删除只解关联不删媒体
 *   · Quality：证书创建/更新、日期可空、到期语义、发布规则、文件关联、数据诚实（不补默认值）
 *   · Applications：CRUD、显式多对多、产品存在性、删除解关联不删产品、slug 冲突
 *
 * 数据库不参与：PrismaService 以 jest mock 替换。
 */

const NOW = new Date('2026-10-15T10:00:00.000Z');
const MEDIA_ID = 'media-1';
const MEDIA_URL = 'http://127.0.0.1:4000/uploads/media/2026/10/cover.png';
const PRODUCT_ID = 'prod-1';

/* ============================ Prisma mock ============================ */

function makeFactoryPrismaMock() {
  return {
    factorySection: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    factoryImage: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    factoryExhibition: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    mediaAsset: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
    _mock: true,
  };
}

function makeQualityPrismaMock() {
  return {
    qualityRecord: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    mediaAsset: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
}

function makeApplicationsPrismaMock() {
  return {
    application: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    applicationProduct: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      upsert: jest.fn(),
    },
    product: { findMany: jest.fn() },
    mediaAsset: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
}

type AnyMock = Record<string, any>;

function wireTransaction(prisma: AnyMock): void {
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: AnyMock) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
}

/* ============================ Factory ============================ */

describe('FactorySectionsService', () => {
  let prisma: ReturnType<typeof makeFactoryPrismaMock>;
  let service: FactorySectionsService;

  beforeEach(() => {
    prisma = makeFactoryPrismaMock();
    wireTransaction(prisma as unknown as AnyMock);
    service = new FactorySectionsService(
      prisma as unknown as PrismaService,
      makeRevalidationMock(),
    );
  });

  function sectionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sec-1',
      title: '生产车间',
      slug: 'production-workshop',
      sectionType: FactorySectionType.PRODUCTION,
      summary: '摘要',
      content: '<p>正文</p>',
      coverMediaId: MEDIA_ID,
      coverImageUrl: MEDIA_URL,
      status: ContentStatus.DRAFT,
      sortOrder: 0,
      publishedAt: null,
      seoTitle: null,
      seoDescription: null,
      createdAt: NOW,
      updatedAt: NOW,
      coverMedia: { id: MEDIA_ID, url: MEDIA_URL, altText: null, width: 100, height: 100, mimeType: 'image/png' },
      images: [],
      exhibitions: [],
      _count: { images: 0, exhibitions: 0 },
      ...overrides,
    };
  }

  describe('list', () => {
    it('分页 + sectionType/status 筛选 + keyword 模糊搜索', async () => {
      prisma.$transaction.mockResolvedValue([1, [sectionRow()]]);
      const result = await service.list({
        page: 1,
        limit: 20,
        keyword: '生产',
        sectionType: FactorySectionType.PRODUCTION,
        status: ContentStatus.PUBLISHED,
      } as never);

      expect(result.total).toBe(1);
      expect(result.items[0].slug).toBe('production-workshop');
      const [countArgs] = prisma.factorySection.count.mock.calls[0];
      expect(countArgs.where.sectionType).toBe(FactorySectionType.PRODUCTION);
      expect(countArgs.where.status).toBe(ContentStatus.PUBLISHED);
      expect(countArgs.where.OR).toHaveLength(3);
    });

    it('limit 上限夹取为 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);
      await service.list({ limit: 9999 } as never);
      const [countArgs] = prisma.factorySection.count.mock.calls[0];
      expect(countArgs).toBeDefined();
      const findArgs = prisma.factorySection.findMany.mock.calls[0][0];
      expect(findArgs.take).toBe(100);
    });
  });

  describe('create', () => {
    it('slug 冲突抛 409', async () => {
      prisma.factorySection.findUnique.mockResolvedValue({ id: 'other' });
      await expect(
        service.create({
          title: 'X',
          slug: 'dup',
          sectionType: FactorySectionType.OVERVIEW,
        } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('封面媒体不存在抛 400', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(null);
      prisma.mediaAsset.findUnique.mockResolvedValue(null);
      await expect(
        service.create({
          title: 'X',
          slug: 'ok',
          sectionType: FactorySectionType.OVERVIEW,
          coverMediaId: 'missing',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('图库媒体缺失抛 400（批量去重校验）', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(null);
      prisma.mediaAsset.findMany.mockResolvedValue([{ id: MEDIA_ID }]);
      await expect(
        service.create({
          title: 'X',
          slug: 'ok',
          sectionType: FactorySectionType.FACILITY,
          images: [{ mediaId: MEDIA_ID }, { mediaId: 'ghost' }],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('创建成功：DRAFT 下 publishedAt 为 null，content 经净化', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(null);
      prisma.mediaAsset.findMany.mockResolvedValue([]);
      prisma.factorySection.create.mockResolvedValue({ id: 'sec-1' });
      prisma.factorySection.findUniqueOrThrow.mockResolvedValue(
        sectionRow({ content: '<p>正文</p>', status: ContentStatus.DRAFT }),
      );

      const result = await service.create({
        title: '生产车间',
        slug: 'production-workshop',
        sectionType: FactorySectionType.PRODUCTION,
        content: '<p>正文</p><script>alert(1)</script>',
      } as never);

      expect(result.status).toBe(ContentStatus.DRAFT);
      expect(result.publishedAt).toBeNull();
      const createArgs = (prisma.factorySection.create as any).mock.calls[0][0];
      expect(createArgs.data.content).toBe('<p>正文</p>');
    });

    it('创建时 PUBLISHED 自动写入 publishedAt', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(null);
      prisma.mediaAsset.findMany.mockResolvedValue([]);
      prisma.factorySection.create.mockResolvedValue({ id: 'sec-1' });
      prisma.factorySection.findUniqueOrThrow.mockResolvedValue(sectionRow({ status: ContentStatus.PUBLISHED }));

      await service.create({
        title: 'X',
        slug: 'x',
        sectionType: FactorySectionType.OVERVIEW,
        status: ContentStatus.PUBLISHED,
      } as never);

      const createArgs = (prisma.factorySection.create as any).mock.calls[0][0];
      expect(createArgs.data.publishedAt).toBeInstanceOf(Date);
    });

    it('展会照片媒体缺失抛 400', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(null);
      prisma.mediaAsset.findMany.mockResolvedValue([]);
      await expect(
        service.create({
          title: 'X',
          slug: 'x',
          sectionType: FactorySectionType.EXHIBITION,
          exhibitions: [{ name: '展会', photos: [{ mediaId: 'ghost' }] }],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('创建后同步展会（deleteMany + createMany 照片）', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(null);
      prisma.mediaAsset.findMany.mockResolvedValue([{ id: MEDIA_ID }]);
      prisma.factorySection.create.mockResolvedValue({ id: 'sec-new' });
      prisma.factoryExhibition.findMany.mockResolvedValue([]);
      prisma.factoryExhibition.create.mockResolvedValue({ id: 'exh-1' });
      prisma.factorySection.findUniqueOrThrow.mockResolvedValue(sectionRow({ id: 'sec-new' }));

      await service.create({
        title: 'X',
        slug: 'x',
        sectionType: FactorySectionType.EXHIBITION,
        exhibitions: [{ name: '广州展', photos: [{ mediaId: MEDIA_ID }] }],
      } as never);

      expect(prisma.factoryExhibition.create).toHaveBeenCalled();
      expect(prisma.factoryImage.deleteMany).toHaveBeenCalledWith({ where: { exhibitionId: 'exh-1' } });
      expect(prisma.factoryImage.createMany).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('路由不存在抛 404', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(null);
      await expect(service.update('nope', {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('换 slug 时检查冲突', async () => {
      prisma.factorySection.findUnique
        .mockResolvedValueOnce(sectionRow()) // existing
        .mockResolvedValueOnce({ id: 'other' }); // slug 占用
      await expect(service.update('sec-1', { slug: 'taken' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('DRAFT 保留历史 publishedAt（重新发布不重置首发时间）', async () => {
      const historic = new Date('2026-01-01T00:00:00.000Z');
      prisma.factorySection.findUnique.mockResolvedValue(sectionRow({ publishedAt: historic }));
      prisma.factorySection.update.mockResolvedValue({});
      prisma.factorySection.findUniqueOrThrow.mockResolvedValue(sectionRow({ publishedAt: historic }));

      await service.update('sec-1', { status: ContentStatus.DRAFT });

      const updateArgs = (prisma.factorySection.update as any).mock.calls[0][0];
      expect(updateArgs.data.publishedAt).toEqual(historic);
    });

    it('coverMediaId = null 清空封面（含地址快照）', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(sectionRow());
      prisma.factorySection.update.mockResolvedValue({});
      prisma.factorySection.findUniqueOrThrow.mockResolvedValue(
        sectionRow({ coverMediaId: null, coverImageUrl: null, coverMedia: null }),
      );

      await service.update('sec-1', { coverMediaId: null });

      const updateArgs = (prisma.factorySection.update as any).mock.calls[0][0];
      expect(updateArgs.data.coverMediaId).toBeNull();
      expect(updateArgs.data.coverImageUrl).toBeNull();
    });

    it('图库整体替换：先删非展会图再插新集合', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(sectionRow());
      prisma.mediaAsset.findMany.mockResolvedValue([{ id: MEDIA_ID }]);
      prisma.factorySection.update.mockResolvedValue({});
      prisma.factorySection.findUniqueOrThrow.mockResolvedValue(sectionRow());

      await service.update('sec-1', { images: [{ mediaId: MEDIA_ID }] });

      expect(prisma.factoryImage.deleteMany).toHaveBeenCalledWith({
        where: { sectionId: 'sec-1', exhibitionId: null },
      });
      expect(prisma.factoryImage.createMany).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('不存在抛 404', async () => {
      prisma.factorySection.findUnique.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('删除只删分区本身，绝不删除 MediaAsset', async () => {
      prisma.factorySection.findUnique.mockResolvedValue({ id: 'sec-1' });
      prisma.factorySection.delete.mockResolvedValue({ id: 'sec-1' });

      const result = await service.remove('sec-1');

      expect(result).toEqual({ id: 'sec-1' });
      expect(prisma.factorySection.delete).toHaveBeenCalledWith({ where: { id: 'sec-1' } });
      expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
      // 无任何媒体删除调用
      expect(prisma.mediaAsset.findMany).not.toHaveBeenCalled();
    });
  });
});

/* ============================ Quality ============================ */

describe('QualityRecordsService', () => {
  let prisma: ReturnType<typeof makeQualityPrismaMock>;
  let service: QualityRecordsService;

  beforeEach(() => {
    prisma = makeQualityPrismaMock();
    wireTransaction(prisma as unknown as AnyMock);
    service = new QualityRecordsService(
      prisma as unknown as PrismaService,
      makeRevalidationMock(),
    );
  });

  function recordRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'qr-1',
      title: 'FSC 认证',
      slug: 'fsc-cert',
      recordType: QualityRecordType.CERTIFICATION,
      issuer: 'FSC',
      certificateNumber: 'FSC-C123456',
      issueDate: new Date('2025-01-01T00:00:00.000Z'),
      expiryDate: new Date('2027-01-01T00:00:00.000Z'),
      description: '描述',
      mediaId: MEDIA_ID,
      status: ContentStatus.DRAFT,
      sortOrder: 0,
      publishedAt: null,
      seoTitle: null,
      seoDescription: null,
      createdAt: NOW,
      updatedAt: NOW,
      media: {
        id: MEDIA_ID,
        url: MEDIA_URL,
        originalName: 'fsc.pdf',
        altText: null,
        width: null,
        height: null,
        mimeType: 'application/pdf',
      },
      ...overrides,
    };
  }

  describe('create', () => {
    it('QUALITY_CONTROL 类记录允许证书编号与日期全空（数据诚实）', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(null);
      prisma.qualityRecord.create.mockResolvedValue(
        recordRow({
          recordType: QualityRecordType.QUALITY_CONTROL,
          issuer: null,
          certificateNumber: null,
          issueDate: null,
          expiryDate: null,
        }),
      );

      const result = await service.create({
        title: '出厂抽检流程',
        slug: 'qc-flow',
        recordType: QualityRecordType.QUALITY_CONTROL,
      } as never);

      const createArgs = (prisma.qualityRecord.create as any).mock.calls[0][0];
      expect(createArgs.data.issuer).toBeNull();
      expect(createArgs.data.certificateNumber).toBeNull();
      expect(createArgs.data.issueDate).toBeNull();
      expect(createArgs.data.expiryDate).toBeNull();
      expect(result.expiryDate).toBeNull();
    });

    it('不补任何占位值 —— 未提供即为 null', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(null);
      prisma.qualityRecord.create.mockResolvedValue(
        recordRow({ issuer: null, certificateNumber: null }),
      );

      await service.create({
        title: 'X',
        slug: 'x',
        recordType: QualityRecordType.STANDARD,
      } as never);

      const createArgs = (prisma.qualityRecord.create as any).mock.calls[0][0];
      expect(createArgs.data.issuer).toBeNull();
      expect(createArgs.data.certificateNumber).toBeNull();
    });

    it('slug 冲突抛 409', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue({ id: 'other' });
      await expect(
        service.create({ title: 'X', slug: 'dup', recordType: QualityRecordType.CERTIFICATION } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('文件媒体不存在抛 400', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(null);
      prisma.mediaAsset.findUnique.mockResolvedValue(null);
      await expect(
        service.create({
          title: 'X',
          slug: 'x',
          recordType: QualityRecordType.CERTIFICATION,
          mediaId: 'ghost',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('创建成功默认 DRAFT，publishedAt 为 null', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(null);
      prisma.qualityRecord.create.mockResolvedValue(recordRow());

      const result = await service.create({
        title: 'FSC 认证',
        slug: 'fsc-cert',
        recordType: QualityRecordType.CERTIFICATION,
      } as never);

      expect(result.status).toBe(ContentStatus.DRAFT);
      expect(result.publishedAt).toBeNull();
    });

    it('PDF 文件被识别为 isDocument', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(null);
      prisma.mediaAsset.findUnique.mockResolvedValue({ id: MEDIA_ID });
      prisma.qualityRecord.create.mockResolvedValue(recordRow());

      const result = await service.create({
        title: 'FSC 认证',
        slug: 'fsc-cert',
        recordType: QualityRecordType.CERTIFICATION,
        mediaId: MEDIA_ID,
      } as never);

      expect(result.media?.isDocument).toBe(true);
      expect(result.media?.originalName).toBe('fsc.pdf');
    });
  });

  describe('update', () => {
    it('不存在抛 404', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(null);
      await expect(service.update('nope', {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('显式 null 清空日期（不写入错误日期）', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(recordRow());
      prisma.qualityRecord.update.mockResolvedValue({});
      prisma.qualityRecord.findUnique.mockResolvedValueOnce(recordRow());
      prisma.qualityRecord.findUnique.mockResolvedValue(recordRow({ expiryDate: null }));

      await service.update('qr-1', { expiryDate: null });

      const updateArgs = (prisma.qualityRecord.update as any).mock.calls[0][0];
      expect(updateArgs.data.expiryDate).toBeNull();
    });

    it('未传日期字段则不改动（undefined 保持原值）', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(recordRow());
      prisma.qualityRecord.update.mockResolvedValue({});
      prisma.qualityRecord.findUnique.mockResolvedValue(recordRow());

      await service.update('qr-1', { title: '新标题' });

      const updateArgs = (prisma.qualityRecord.update as any).mock.calls[0][0];
      expect('expiryDate' in updateArgs.data).toBe(false);
      expect('issueDate' in updateArgs.data).toBe(false);
    });

    it('空串证书编号归一为 null', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(recordRow());
      prisma.qualityRecord.update.mockResolvedValue({});
      prisma.qualityRecord.findUnique.mockResolvedValue(recordRow());

      await service.update('qr-1', { certificateNumber: '   ' });

      const updateArgs = (prisma.qualityRecord.update as any).mock.calls[0][0];
      expect(updateArgs.data.certificateNumber).toBeNull();
    });

    it('mediaId = null 解除文件关联（不删媒体）', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(recordRow());
      prisma.qualityRecord.update.mockResolvedValue({});
      prisma.qualityRecord.findUnique.mockResolvedValue(recordRow({ mediaId: null, media: null }));

      await service.update('qr-1', { mediaId: null });

      const updateArgs = (prisma.qualityRecord.update as any).mock.calls[0][0];
      expect(updateArgs.data.mediaId).toBeNull();
    });
  });

  describe('remove', () => {
    it('不存在抛 404', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('删除记录不删除媒体', async () => {
      prisma.qualityRecord.findUnique.mockResolvedValue({ id: 'qr-1' });
      prisma.qualityRecord.delete.mockResolvedValue({ id: 'qr-1' });

      const result = await service.remove('qr-1');

      expect(result).toEqual({ id: 'qr-1' });
      expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
    });
  });
});

/* ============================ Applications ============================ */

describe('ApplicationsService', () => {
  let prisma: ReturnType<typeof makeApplicationsPrismaMock>;
  let service: ApplicationsService;

  beforeEach(() => {
    prisma = makeApplicationsPrismaMock();
    wireTransaction(prisma as unknown as AnyMock);
    service = new ApplicationsService(
      prisma as unknown as PrismaService,
      makeRevalidationMock(),
    );
  });

  function appRow(overrides: Record<string, unknown> = {}) {
    const products = overrides.products ?? [];
    return {
      id: 'app-1',
      name: '家具制造',
      slug: 'furniture',
      summary: '摘要',
      description: '描述',
      coverMediaId: MEDIA_ID,
      coverImageUrl: MEDIA_URL,
      status: ContentStatus.DRAFT,
      featured: false,
      sortOrder: 0,
      publishedAt: null,
      seoTitle: null,
      seoDescription: null,
      createdAt: NOW,
      updatedAt: NOW,
      coverMedia: { id: MEDIA_ID, url: MEDIA_URL, altText: null, width: 10, height: 10, mimeType: 'image/png' },
      products,
      _count: { products: (products as unknown[]).length },
      ...overrides,
    };
  }

  describe('create', () => {
    it('slug 冲突抛 409', async () => {
      prisma.application.findUnique.mockResolvedValue({ id: 'other' });
      await expect(
        service.create({ name: 'X', slug: 'dup' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('关联产品不存在抛 400（报告缺失 id）', async () => {
      prisma.application.findUnique.mockResolvedValue(null);
      prisma.product.findMany.mockResolvedValue([{ id: PRODUCT_ID }]);
      await expect(
        service.create({
          name: 'X',
          slug: 'x',
          products: [{ productId: PRODUCT_ID }, { productId: 'ghost' }],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('创建成功并写入显式多对多关联', async () => {
      prisma.application.findUnique.mockResolvedValue(null);
      prisma.product.findMany.mockResolvedValue([{ id: PRODUCT_ID }]);
      prisma.application.create.mockResolvedValue({ id: 'app-new' });
      prisma.applicationProduct.createMany.mockResolvedValue({ count: 1 });
      prisma.application.findUniqueOrThrow.mockResolvedValue(
        appRow({
          id: 'app-new',
          products: [
            {
              applicationId: 'app-new',
              productId: PRODUCT_ID,
              sortOrder: 0,
              product: { id: PRODUCT_ID, name: 'P', slug: 'p', status: 'PUBLISHED' },
            },
          ],
        }),
      );

      const result = await service.create({
        name: '家具制造',
        slug: 'furniture',
        products: [{ productId: PRODUCT_ID }],
      } as never);

      expect(prisma.applicationProduct.createMany).toHaveBeenCalled();
      expect(result.products).toHaveLength(1);
      expect(result.products[0].id).toBe(PRODUCT_ID);
    });

    it('重复 productId 去重（避免复合主键冲突）', async () => {
      prisma.application.findUnique.mockResolvedValue(null);
      prisma.product.findMany.mockResolvedValue([{ id: PRODUCT_ID }]);
      prisma.application.create.mockResolvedValue({ id: 'app-new' });
      prisma.applicationProduct.createMany.mockResolvedValue({ count: 1 });
      prisma.application.findUniqueOrThrow.mockResolvedValue(appRow({ id: 'app-new' }));

      await service.create({
        name: 'X',
        slug: 'x',
        products: [{ productId: PRODUCT_ID }, { productId: PRODUCT_ID }],
      } as never);

      const createManyArgs = (prisma.applicationProduct.createMany as any).mock.calls[0][0];
      expect(createManyArgs.data).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('不存在抛 404', async () => {
      prisma.application.findUnique.mockResolvedValue(null);
      await expect(service.update('nope', {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('products 整体替换：先删未保留的关联，再 upsert', async () => {
      prisma.application.findUnique.mockResolvedValue(appRow());
      prisma.product.findMany.mockResolvedValue([{ id: PRODUCT_ID }]);
      prisma.application.update.mockResolvedValue({});
      prisma.applicationProduct.deleteMany.mockResolvedValue({ count: 1 });
      prisma.applicationProduct.upsert.mockResolvedValue({});
      prisma.application.findUnique.mockResolvedValue(appRow());

      await service.update('app-1', { products: [{ productId: PRODUCT_ID }] });

      expect(prisma.applicationProduct.deleteMany).toHaveBeenCalledWith({
        where: { applicationId: 'app-1', productId: { notIn: [PRODUCT_ID] } },
      });
      expect(prisma.applicationProduct.upsert).toHaveBeenCalled();
    });

    it('产品非法引用抛 400', async () => {
      prisma.application.findUnique.mockResolvedValue(appRow());
      prisma.product.findMany.mockResolvedValue([]);
      await expect(
        service.update('app-1', { products: [{ productId: 'ghost' }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('封面 null 清空', async () => {
      prisma.application.findUnique.mockResolvedValue(appRow());
      prisma.application.update.mockResolvedValue({});
      prisma.application.findUnique.mockResolvedValue(appRow({ coverMediaId: null, coverImageUrl: null }));

      await service.update('app-1', { coverMediaId: null });

      const updateArgs = (prisma.application.update as any).mock.calls[0][0];
      expect(updateArgs.data.coverMediaId).toBeNull();
      expect(updateArgs.data.coverImageUrl).toBeNull();
    });
  });

  describe('remove', () => {
    it('不存在抛 404', async () => {
      prisma.application.findUnique.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('删除应用场景不删除产品', async () => {
      prisma.application.findUnique.mockResolvedValue({ id: 'app-1' });
      prisma.application.delete.mockResolvedValue({ id: 'app-1' });

      const result = await service.remove('app-1');

      expect(result).toEqual({ id: 'app-1' });
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });
  });
});
