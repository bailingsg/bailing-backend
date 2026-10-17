import { BadRequestException } from '@nestjs/common';
import { ContentStatus, SitePage } from '@prisma/client';
import { SiteSectionsService } from '../src/modules/cms/site/site-sections.service';
import { NavItemsService } from '../src/modules/cms/site/nav-items.service';
import { AuditLogService } from '../src/modules/rbac/audit-log.service';
import type { ActorContext } from '../src/modules/rbac/actor-context';
import { makeRevalidationMock } from './helpers/revalidation-mock';
import {
  parseSiteSectionItems,
  parseSiteSectionStats,
} from '../src/modules/cms/site/entities/site.entity';
import type { PrismaService } from '../src/modules/prisma/prisma.service';

/**
 * 站点内容 CMS 服务测试（Phase 4.7）。
 *
 * 覆盖：URL 安全校验（写入路径）、发布完整性、状态流转、分区键唯一、
 * 媒体存在性、items/stats 脏数据读出降级。
 */

const ACTOR: ActorContext = {
  id: 'admin-1',
  email: 'admin@bailingwooden.test',
  name: '管理员',
  permissions: new Set(['site.read', 'site.create', 'site.update', 'site.delete']),
  isSuperAdmin: true,
};

function makePrismaMock() {
  return {
    siteSection: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    mediaAsset: { findUnique: jest.fn() },
    navItem: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn().mockImplementation((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)({
            siteSection: { update: jest.fn().mockResolvedValue({}) },
          })
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
}

const CREATED_ROW = {
  id: 'sec-1',
  page: SitePage.HOME,
  sectionKey: 'home.hero',
  eyebrow: null,
  title: 'Hero title',
  subtitle: null,
  body: null,
  mediaId: null,
  ctaLabel: null,
  ctaUrl: null,
  items: null,
  stats: null,
  status: ContentStatus.DRAFT,
  sortOrder: 10,
  createdBy: 'admin-1',
  createdAt: new Date('2026-10-16T00:00:00.000Z'),
  updatedAt: new Date('2026-10-16T00:00:00.000Z'),
  publishedAt: null,
  media: null,
};

function makeService(prisma: ReturnType<typeof makePrismaMock>): SiteSectionsService {
  return new SiteSectionsService(
    prisma as unknown as PrismaService,
    { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogService,
    makeRevalidationMock(),
  );
}

describe('SiteSectionsService（Phase 4.7）', () => {
  const baseCreate = {
    page: SitePage.HOME,
    sectionKey: 'home.hero',
    title: 'Hero title',
  };

  it('创建成功：默认 DRAFT，publishedAt 为 null', async () => {
    const prisma = makePrismaMock();
    prisma.siteSection.findUnique.mockResolvedValue(null);
    prisma.siteSection.create.mockResolvedValue(CREATED_ROW);
    const service = makeService(prisma);

    const dto = await service.create(baseCreate as never, ACTOR);

    expect(dto.status).toBe('DRAFT');
    expect(dto.publishedAt).toBeNull();
    expect(prisma.siteSection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ContentStatus.DRAFT,
          publishedAt: null,
          sortOrder: 0,
        }),
      }),
    );
  });

  it('重复分区键（同页同键）被 400 拒绝', async () => {
    const prisma = makePrismaMock();
    prisma.siteSection.findUnique.mockResolvedValue({ id: 'sec-existing' });
    const service = makeService(prisma);

    await expect(service.create(baseCreate as never, ACTOR)).rejects.toThrow(BadRequestException);
    expect(prisma.siteSection.create).not.toHaveBeenCalled();
  });

  it('非法 sectionKey 格式被 400 拒绝', async () => {
    const prisma = makePrismaMock();
    const service = makeService(prisma);

    await expect(
      service.create({ ...baseCreate, sectionKey: 'Home Hero' } as never, ACTOR),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ ...baseCreate, sectionKey: 'home__hero' } as never, ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('ctaUrl 含危险协议被 400 拒绝（写入路径强制）', async () => {
    const prisma = makePrismaMock();
    prisma.siteSection.findUnique.mockResolvedValue(null);
    const service = makeService(prisma);

    await expect(
      service.create({ ...baseCreate, ctaUrl: 'javascript:alert(1)' } as never, ACTOR),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ ...baseCreate, ctaUrl: 'http://evil.com' } as never, ACTOR),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ ...baseCreate, ctaUrl: '//evil.com' } as never, ACTOR),
    ).rejects.toThrow(BadRequestException);

    // 合法链接放行
    prisma.siteSection.create.mockResolvedValue(CREATED_ROW);
    await service.create({ ...baseCreate, ctaUrl: '/contact#rfq' } as never, ACTOR);
    expect(prisma.siteSection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ctaUrl: '/contact#rfq' }),
      }),
    );
  });

  it('items[].href 危险协议被 400 拒绝', async () => {
    const prisma = makePrismaMock();
    prisma.siteSection.findUnique.mockResolvedValue(null);
    const service = makeService(prisma);

    await expect(
      service.create(
        {
          ...baseCreate,
          items: [{ title: 'Card', href: 'javascript:alert(1)' }],
        } as never,
        ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.siteSection.create).not.toHaveBeenCalled();
  });

  it('创建时传入 PUBLISHED 被强制降级为 DRAFT（不能绕过发布动作上线）', async () => {
    const prisma = makePrismaMock();
    prisma.siteSection.findUnique.mockResolvedValue(null);
    prisma.siteSection.create.mockResolvedValue(CREATED_ROW);
    const service = makeService(prisma);

    await service.create(
      { page: SitePage.HOME, sectionKey: 'home.empty', status: ContentStatus.PUBLISHED } as never,
      ACTOR,
    );

    expect(prisma.siteSection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ContentStatus.DRAFT,
          publishedAt: null,
        }),
      }),
    );
  });

  it('创建恒为 DRAFT 且 publishedAt 为 null', async () => {
    const prisma = makePrismaMock();
    prisma.siteSection.findUnique.mockResolvedValue(null);
    prisma.siteSection.create.mockResolvedValue(CREATED_ROW);
    const service = makeService(prisma);

    await service.create({ ...baseCreate } as never, ACTOR);

    expect(prisma.siteSection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ContentStatus.DRAFT,
          publishedAt: null,
        }),
      }),
    );
  });

  it('引用的媒体不存在被 400 拒绝', async () => {
    const prisma = makePrismaMock();
    prisma.siteSection.findUnique.mockResolvedValue(null);
    prisma.mediaAsset.findUnique.mockResolvedValue(null);
    const service = makeService(prisma);

    await expect(
      service.create({ ...baseCreate, mediaId: 'media-missing' } as never, ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('更新：DRAFT → PUBLISHED 记录发布时间；PUBLISHED → ARCHIVED 保留历史时间', async () => {
    const prisma = makePrismaMock();
    const publishedAt = new Date('2026-10-01T00:00:00.000Z');
    prisma.siteSection.findUnique.mockResolvedValue({
      ...CREATED_ROW,
      status: ContentStatus.PUBLISHED,
      publishedAt,
    });
    const archivedRow = { ...CREATED_ROW, status: ContentStatus.ARCHIVED, publishedAt };
    prisma.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)({
            siteSection: { update: jest.fn().mockResolvedValue(archivedRow) },
          })
        : Promise.all(arg as Promise<unknown>[]),
    );
    const service = makeService(prisma);

    const dto = await service.update('sec-1', { status: ContentStatus.ARCHIVED } as never, ACTOR);

    expect(dto.status).toBe('ARCHIVED');
    expect(dto.publishedAt).toBe(publishedAt.toISOString());
  });
});

describe('NavItemsService URL 校验（Phase 4.7）', () => {
  function makeNavService(prisma: ReturnType<typeof makePrismaMock>): NavItemsService {
    return new NavItemsService(
      prisma as unknown as PrismaService,
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogService,
      makeRevalidationMock(),
    );
  }

  it('合法链接创建成功', async () => {
    const prisma = makePrismaMock();
    prisma.navItem.create.mockResolvedValue({
      id: 'nav-1',
      location: 'HEADER',
      label: 'Products',
      url: '/products',
      sortOrder: 10,
      isActive: true,
      openInNewTab: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const service = makeNavService(prisma);

    const dto = await service.create(
      { location: 'HEADER', label: 'Products', url: '/products', sortOrder: 10 } as never,
      ACTOR,
    );
    expect(dto.url).toBe('/products');
  });

  it('危险协议 / 混合内容 / protocol-relative 一律 400', async () => {
    const prisma = makePrismaMock();
    const service = makeNavService(prisma);

    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'http://insecure.example.com',
      '//evil.example.com',
      '/\\evil.example.com',
      'evil.example.com',
    ]) {
      await expect(
        service.create({ location: 'HEADER', label: 'X', url } as never, ACTOR),
      ).rejects.toThrow(BadRequestException);
    }
    expect(prisma.navItem.create).not.toHaveBeenCalled();
  });
});

describe('items / stats 读出白名单（脏数据降级）', () => {
  it('非数组 / 缺字段 / 超长 / 超量项被降级而非透传', () => {
    expect(parseSiteSectionItems(null)).toEqual([]);
    expect(parseSiteSectionItems('not-array')).toEqual([]);
    expect(parseSiteSectionItems([{ description: 'no title' }])).toEqual([]);
    expect(parseSiteSectionItems([{ title: '' }])).toEqual([]);
    expect(parseSiteSectionItems([{ title: 'x'.repeat(121) }])).toEqual([]);
    expect(parseSiteSectionItems([{ title: 'ok', description: 'x'.repeat(401) }])).toEqual([
      { title: 'ok', description: null, href: null },
    ]);
    // 超过 8 项只保留前 8 个合法项
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}` }));
    expect(parseSiteSectionItems(many)).toHaveLength(8);
    // 未知字段被丢弃
    expect(parseSiteSectionItems([{ title: 'ok', evil: '<script>' }])).toEqual([
      { title: 'ok', description: null, href: null },
    ]);
  });

  it('stats 缺 label / value 被丢弃，超 6 项截断', () => {
    expect(parseSiteSectionStats([{ label: 'Years' }])).toEqual([]);
    expect(parseSiteSectionStats([{ label: 'Years', value: '20' }])).toEqual([
      { label: 'Years', value: '20' },
    ]);
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `l${i}`, value: 'v' }));
    expect(parseSiteSectionStats(many)).toHaveLength(6);
  });
});
