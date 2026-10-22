import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProductStatus, Prisma } from '@prisma/client';
import { existsSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProductsService } from '../src/modules/cms/products/products.service';
import { ProductCategoriesService } from '../src/modules/cms/products/product-categories.service';
import { CreateProductDto, UpdateProductDto } from '../src/modules/cms/products/dto/product.dto';
import { CreateCategoryDto, UpdateCategoryDto } from '../src/modules/cms/products/dto/category.dto';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { makeRevalidationMock } from './helpers/revalidation-mock';

/**
 * Products CMS 单元测试（Phase 4.2）。
 *
 * 覆盖任务书要求：
 *   · Product CRUD（list 分页/筛选参数、create 默认值、update 部分字段、delete）
 *   · Category CRUD（productCount 聚合、slug 冲突 409、有产品禁删 400、404）
 *   · Product Image Relation（主图默认/唯一、魔数校验失败即删文件、删除提升新主图）
 *   · Prisma 错误映射（P2002 → 409、P2025 → 404）
 *
 * 数据库不参与：PrismaClient 以 jest mock 替换，文件系统用真实临时目录。
 */

const NOW = new Date('2026-10-14T12:00:00.000Z');

function makePrismaMock() {
  return {
    product: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      groupBy: jest.fn(),
    },
    productImage: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    // Phase 5.6：产品图片上传时同步登记媒体资产（用途 = 产品）
    mediaAsset: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    category: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
    contentDraft: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    contentRevision: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), create: jest.fn(), findMany: jest.fn() },
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeConfigMock(): ConfigService {
  return { getOrThrow: jest.fn().mockReturnValue('http://localhost:4000') } as unknown as ConfigService;
}

/* ----------------------------- 数据工厂 ----------------------------- */

function makeProductRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    name: 'Oak Plywood',
    slug: 'oak-plywood',
    categoryId: 'cat-1',
    shortDescription: 'short',
    description: 'long description',
    material: 'Oak',
    application: 'Furniture',
    applications: ['Furniture', 'Construction'],
    specifications: { thickness: '18mm' },
    status: ProductStatus.DRAFT,
    isFeatured: false,
    seoTitle: null,
    seoDescription: null,
    createdAt: NOW,
    updatedAt: NOW,
    category: { id: 'cat-1', name: 'Plywood', slug: 'plywood' },
    images: [],
    ...overrides,
  } as never;
}

function makeCategoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cat-1',
    name: 'Plywood',
    slug: 'plywood',
    description: null,
    sortOrder: 0,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never;
}

function makeImageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'img-1',
    productId: 'prod-1',
    url: 'http://localhost:4000/uploads/products/11111111-1111-1111-1111-111111111111.png',
    altText: null,
    sortOrder: 0,
    isPrimary: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never;
}

function prismaKnownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('mock', {
    code,
    clientVersion: 'test',
  });
}

/* ----------------------------- 分类服务 ----------------------------- */

describe('ProductCategoriesService（unit）', () => {
  let prisma: PrismaMock;
  let service: ProductCategoriesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new ProductCategoriesService(
      prisma as unknown as PrismaService,
      makeRevalidationMock(),
    );
  });

  it('list：返回分类列表并附带各分类产品计数（groupBy 聚合）', async () => {
    prisma.category.findMany.mockResolvedValue([
      makeCategoryRow({ id: 'cat-1', sortOrder: 0 }),
      makeCategoryRow({ id: 'cat-2', name: 'MDF', slug: 'mdf', sortOrder: 1 }),
    ]);
    prisma.product.groupBy.mockResolvedValue([
      { categoryId: 'cat-2', _count: { _all: 3 } },
    ]);

    const list = await service.list();

    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'cat-1', productCount: 0 });
    expect(list[1]).toMatchObject({ id: 'cat-2', name: 'MDF', productCount: 3 });
    expect(list[0].createdAt).toBe(NOW.toISOString());
    // 无产品的分类计数为 0（不返回 undefined）
    expect(list[0].productCount).toBe(0);
  });

  it('create：成功创建并返回 productCount=0', async () => {
    prisma.category.create.mockResolvedValue(makeCategoryRow());
    const dto: CreateCategoryDto = { name: 'Plywood', slug: 'plywood' };

    const created = await service.create(dto);

    expect(created).toMatchObject({ id: 'cat-1', slug: 'plywood', productCount: 0 });
    expect(prisma.category.create).toHaveBeenCalledWith({
      data: { name: 'Plywood', slug: 'plywood', description: null, sortOrder: 0, isActive: true },
    });
  });

  it('create：slug 唯一冲突（P2002）映射为 409', async () => {
    prisma.category.create.mockRejectedValue(prismaKnownError('P2002'));
    await expect(
      service.create({ name: 'Plywood', slug: 'plywood' } as CreateCategoryDto),
    ).rejects.toThrow(ConflictException);
  });

  it('update：分类不存在返回 404；存在则部分更新', async () => {
    prisma.category.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { name: 'X' } as UpdateCategoryDto)).rejects.toThrow(
      NotFoundException,
    );

    prisma.category.findUnique.mockResolvedValue(makeCategoryRow());
    prisma.category.update.mockResolvedValue(makeCategoryRow({ name: 'Plywood Pro' }));
    prisma.product.count.mockResolvedValue(2);

    const updated = await service.update('cat-1', { name: 'Plywood Pro' } as UpdateCategoryDto);

    expect(updated).toMatchObject({ name: 'Plywood Pro', productCount: 2 });
    expect(prisma.category.update).toHaveBeenCalledWith({
      where: { id: 'cat-1' },
      data: { name: 'Plywood Pro' },
    });
  });

  it('remove：分类下存在产品时拒绝删除（400）', async () => {
    prisma.category.findUnique.mockResolvedValue(makeCategoryRow());
    prisma.product.count.mockResolvedValue(4);

    await expect(service.remove('cat-1')).rejects.toThrow(BadRequestException);
    expect(prisma.category.delete).not.toHaveBeenCalled();
  });

  it('remove：空分类可删除；不存在返回 404', async () => {
    prisma.category.findUnique.mockResolvedValue(makeCategoryRow());
    prisma.product.count.mockResolvedValue(0);
    prisma.category.delete.mockResolvedValue(makeCategoryRow());

    await expect(service.remove('cat-1')).resolves.toEqual({ id: 'cat-1' });

    prisma.category.findUnique.mockResolvedValue(null);
    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
  });
});

/* ----------------------------- 产品服务 ----------------------------- */

describe('ProductsService（unit）', () => {
  let prisma: PrismaMock;
  let service: ProductsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    prisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    service = new ProductsService(
      prisma as unknown as PrismaService,
      makeConfigMock(),
      makeRevalidationMock(),
    );
  });

  /* ------------------------- 查询 ------------------------- */

  it('list：默认分页（page=1, limit=20）并返回分页信封', async () => {
    prisma.product.count.mockResolvedValue(1);
    prisma.product.findMany.mockResolvedValue([makeProductRow()]);

    const result = await service.list({} as never);

    expect(result).toMatchObject({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(result.items[0]).toMatchObject({
      id: 'prod-1',
      name: 'Oak Plywood',
      status: ProductStatus.DRAFT,
      imageCount: 0,
      primaryImage: null,
    });
    expect(prisma.product.count).toHaveBeenCalledWith({ where: {} });
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
  });

  it('list：keyword 生成 OR 不区分大小写三字段匹配', async () => {
    prisma.product.count.mockResolvedValue(0);
    prisma.product.findMany.mockResolvedValue([]);

    await service.list({ keyword: 'oak' } as never);

    expect(prisma.product.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { contains: 'oak', mode: 'insensitive' } },
          { shortDescription: { contains: 'oak', mode: 'insensitive' } },
          { description: { contains: 'oak', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('list：status / categoryId 进入 where；分页参数被夹紧（page 最小 1，limit 最大 100）', async () => {
    prisma.product.count.mockResolvedValue(0);
    prisma.product.findMany.mockResolvedValue([]);

    await service.list({ page: 0, limit: 500, status: 'PUBLISHED', categoryId: 'cat-1' } as never);

    expect(prisma.product.count).toHaveBeenCalledWith({
      where: { status: 'PUBLISHED', categoryId: 'cat-1' },
    });
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 100 }),
    );
  });

  it('findById：不存在返回 404', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
  });

  it('findById：返回详情（含 applications/specifications 归一化与图片排序）', async () => {
    prisma.product.findUnique.mockResolvedValue(
      makeProductRow({
        images: [
          makeImageRow({ id: 'img-b', isPrimary: false, sortOrder: 5 }),
          makeImageRow({ id: 'img-a', isPrimary: true, sortOrder: 9 }),
        ],
      }),
    );

    const detail = await service.findById('prod-1');

    expect(detail.applications).toEqual(['Furniture', 'Construction']);
    expect(detail.specifications).toEqual({ thickness: '18mm' });
    expect(detail.images.map((i) => i.id)).toEqual(['img-a', 'img-b']); // 主图优先
  });

  /* ------------------------- 写入 ------------------------- */

  it('create：分类不存在返回 400（不触碰 product.create）', async () => {
    prisma.category.findUnique.mockResolvedValue(null);
    await expect(
      service.create({ name: 'X', slug: 'x', categoryId: 'missing', description: 'x'.repeat(10) } as CreateProductDto),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('create：成功创建，未提供 status/isFeatured 时默认 DRAFT + false', async () => {
    prisma.category.findUnique.mockResolvedValue(makeCategoryRow());
    prisma.product.create.mockResolvedValue(makeProductRow({ status: ProductStatus.DRAFT }));

    const dto: CreateProductDto = {
      name: 'Oak Plywood',
      slug: 'oak-plywood',
      categoryId: 'cat-1',
      description: 'long description',
    };
    const created = await service.create(dto);

    expect(created.status).toBe(ProductStatus.DRAFT);
    const call = prisma.product.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.status).toBe('DRAFT');
    expect(call.data.isFeatured).toBe(false);
    expect(call.data.applications).toBe(Prisma.JsonNull);
    expect(call.data.specifications).toBe(Prisma.JsonNull);
  });

  it('create：description 入库前经 sanitizeRichText 净化（剥离 script 与无关属性）', async () => {
    prisma.category.findUnique.mockResolvedValue(makeCategoryRow());
    prisma.product.create.mockResolvedValue(makeProductRow({ status: ProductStatus.DRAFT }));

    await service.create({
      name: 'Oak Plywood',
      slug: 'oak-plywood',
      categoryId: 'cat-1',
      description:
        '<div class="module_attribute" data-module-name="module_attribute"><p>正文段落</p>' +
        '<script>alert(1)</script><a href="javascript:alert(2)">bad</a>' +
        '<a href="https://example.com">ok</a></div>',
    } as CreateProductDto);

    const call = prisma.product.create.mock.calls[0][0] as { data: Record<string, unknown> };
    const stored = call.data.description as string;

    // 标签保留，属性剥离
    expect(stored).toContain('<div>');
    expect(stored).not.toContain('module_attribute');
    expect(stored).not.toContain('data-module-name');
    // 危险内容被移除
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('javascript:');
    // 安全链接保留
    expect(stored).toContain('href="https://example.com"');
    // 正文文字保留
    expect(stored).toContain('正文段落');
  });

  it('update：description 同样经 sanitizeRichText 净化', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'prod-1' });
    prisma.product.update.mockResolvedValue(makeProductRow());

    await service.update('prod-1', {
      description: '<p onclick="alert(1)">安全文本</p><iframe src="x"></iframe>',
    } as UpdateProductDto);

    const call = prisma.product.update.mock.calls[0][0] as { data: Record<string, unknown> };
    const stored = call.data.description as string;
    expect(stored).toBe('<p>安全文本</p>');
  });

  it('create：slug 冲突（P2002）映射为 409', async () => {
    prisma.category.findUnique.mockResolvedValue(makeCategoryRow());
    prisma.product.create.mockRejectedValue(prismaKnownError('P2002'));
    await expect(
      service.create({
        name: 'Oak Plywood',
        slug: 'oak-plywood',
        categoryId: 'cat-1',
        description: 'long description',
      } as CreateProductDto),
    ).rejects.toThrow(ConflictException);
  });

  it('update：产品不存在返回 404；部分字段只更新提供的键', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { name: 'X' } as UpdateProductDto)).rejects.toThrow(
      NotFoundException,
    );

    prisma.product.findUnique.mockResolvedValue({ id: 'prod-1' });
    prisma.product.update.mockResolvedValue(makeProductRow({ name: 'Renamed' }));

    await service.update('prod-1', { name: 'Renamed' } as UpdateProductDto);

    const call = prisma.product.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ name: 'Renamed' });
  });

  it('update：切换分类时校验新分类存在性（不存在 400）', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'prod-1' });
    prisma.category.findUnique.mockResolvedValue(null);
    await expect(
      service.update('prod-1', { categoryId: 'missing' } as UpdateProductDto),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  /* ------------------------- 删除 ------------------------- */

  it('remove：产品不存在返回 404；存在时先读图片（供文件清理）再删行', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);

    prisma.product.findUnique.mockResolvedValue({
      id: 'prod-1',
      images: [{ url: 'http://localhost:4000/uploads/products/11111111-1111-1111-1111-111111111111.png' }],
    });
    prisma.product.delete.mockResolvedValue({ id: 'prod-1' });

    await expect(service.remove('prod-1')).resolves.toEqual({ id: 'prod-1' });
    // 删除以 where: { id } 精确执行（不依赖级联前的手动删图行）
    expect(prisma.product.delete).toHaveBeenCalledWith({ where: { id: 'prod-1' } });
  });

  /* --------------------- 图片关系 --------------------- */

  it('addImage：首图默认主图；魔数校验使用真实文件内容', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cms-img-'));
    const filePath = path.join(dir, 'first.png');
    // 合法 PNG 魔数 + 填充
    writeFileSync(
      filePath,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]),
    );

    prisma.product.findUnique.mockResolvedValue({ id: 'prod-1', _count: { images: 0 } });
    prisma.productImage.updateMany.mockResolvedValue({ count: 0 });
    prisma.productImage.create.mockResolvedValue(
      makeImageRow({ isPrimary: true, url: 'http://localhost:4000/uploads/products/first.png' }),
    );

    const image = await service.addImage(
      'prod-1',
      { path: filePath, mimetype: 'image/png', size: 72 },
      {} as never,
    );

    expect(image.isPrimary).toBe(true);
    expect(image.url).toBe('http://localhost:4000/uploads/products/first.png');
    // 设主图前先清理旧主图标记（唯一性）
    expect(prisma.productImage.updateMany).toHaveBeenCalledWith({
      where: { productId: 'prod-1', isPrimary: true },
      data: { isPrimary: false },
    });
    // Phase 5.6：上传即登记媒体资产，用途自动为「产品」
    expect(prisma.mediaAsset.create).toHaveBeenCalledTimes(1);
    const mediaCall = prisma.mediaAsset.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(mediaCall.data.usage).toBe('PRODUCT');
    expect(mediaCall.data.url).toBe('http://localhost:4000/uploads/products/first.png');
  });

  it('addImage：产品不存在时删除已落盘文件并返回 404', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cms-img-'));
    const filePath = path.join(dir, 'gone.png');
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    prisma.product.findUnique.mockResolvedValue(null);

    await expect(
      service.addImage('missing', { path: filePath, mimetype: 'image/png', size: 8 }, {} as never),
    ).rejects.toThrow(NotFoundException);
    expect(existsSync(filePath)).toBe(false); // 磁盘文件已清理
  });

  it('addImage：魔数校验失败（伪造 MIME）即删除文件并返回 400', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cms-img-'));
    const filePath = path.join(dir, 'evil.png');
    writeFileSync(filePath, Buffer.from('<html><script>alert(1)</script></html>'));

    prisma.product.findUnique.mockResolvedValue({ id: 'prod-1', _count: { images: 0 } });

    await expect(
      service.addImage('prod-1', { path: filePath, mimetype: 'image/png', size: 42 }, {} as never),
    ).rejects.toThrow(BadRequestException);
    expect(existsSync(filePath)).toBe(false);
    expect(prisma.productImage.create).not.toHaveBeenCalled();
  });

  it('addImage：非首图且未指定 isPrimary 时不设主图、不清旧主图', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cms-img-'));
    const filePath = path.join(dir, 'second.png');
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    prisma.product.findUnique.mockResolvedValue({ id: 'prod-1', _count: { images: 2 } });
    prisma.productImage.create.mockResolvedValue(makeImageRow({ id: 'img-2', isPrimary: false }));

    const image = await service.addImage(
      'prod-1',
      { path: filePath, mimetype: 'image/png', size: 8 },
      { sortOrder: 3 } as never,
    );

    expect(image.isPrimary).toBe(false);
    expect(prisma.productImage.updateMany).not.toHaveBeenCalled();
    const call = prisma.productImage.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.sortOrder).toBe(3);
    expect(call.data.isPrimary).toBe(false);
  });

  it('removeImage：删除主图后把最早的一张提升为主图', async () => {
    prisma.productImage.findFirst.mockResolvedValue(
      makeImageRow({ id: 'img-1', isPrimary: true }), // 待删主图
    );
    prisma.productImage.delete.mockResolvedValue(makeImageRow());
    prisma.productImage.findFirst
      .mockResolvedValueOnce(makeImageRow({ id: 'img-1', isPrimary: true }))
      .mockResolvedValueOnce(makeImageRow({ id: 'img-2', isPrimary: false })); // 候选新主图
    prisma.productImage.update.mockResolvedValue(makeImageRow({ id: 'img-2', isPrimary: true }));

    await expect(service.removeImage('prod-1', 'img-1')).resolves.toEqual({ id: 'img-1' });

    expect(prisma.productImage.delete).toHaveBeenCalledWith({ where: { id: 'img-1' } });
    expect(prisma.productImage.update).toHaveBeenCalledWith({
      where: { id: 'img-2' },
      data: { isPrimary: true },
    });
  });

  it('removeImage：删除非主图不触发提升；图片不存在返回 404', async () => {
    prisma.productImage.findFirst.mockResolvedValue(
      makeImageRow({ id: 'img-2', isPrimary: false }),
    );
    prisma.productImage.delete.mockResolvedValue(makeImageRow());

    await service.removeImage('prod-1', 'img-2');
    expect(prisma.productImage.update).not.toHaveBeenCalled();

    prisma.productImage.findFirst.mockResolvedValue(null);
    await expect(service.removeImage('prod-1', 'img-x')).rejects.toThrow(NotFoundException);
  });
});
