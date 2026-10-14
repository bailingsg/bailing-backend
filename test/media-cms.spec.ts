import { BadRequestException } from '@nestjs/common';
import { MediaCategory, MediaProvider } from '@prisma/client';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { LocalStorageProvider } from '../src/modules/media/storage/local-storage.provider';
import type { StorageProvider } from '../src/modules/media/storage/storage.interface';
import {
  MAX_MEDIA_FILE_SIZE,
  parseImageDimensions,
  validateUpload,
  verifyImageSignature,
} from '../src/modules/media/media-file.util';
import { MediaService } from '../src/modules/media/media.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import type { ListMediaQueryDto } from '../src/modules/media/dto/list-media-query.dto';

/**
 * Media CMS 单元测试（Phase 4.3）。
 *
 * 覆盖任务书要求：
 *   · File Validation（MIME 白名单 / 大小限制 / 魔数校验）
 *   · Image Dimensions（PNG / JPEG / WebP / AVIF 文件头解析）
 *   · Storage Adapter（LocalProvider：storageKey 生成、防路径穿越、删除静默）
 *   · Media CRUD（list 分页/筛选、findById 404、remove 引用检查）
 *   · Reference Check（被 ProductImage 引用 → 400 "Media asset is in use."）
 *
 * 数据库不参与：PrismaClient 以 jest mock 替换；LocalProvider 用真实临时目录。
 */

const NOW = new Date('2026-10-14T12:00:00.000Z');

/* ----------------------------- 测试图片字节 ----------------------------- */

/** 合法 PNG：640×480（签名 + IHDR） */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]), // IHDR
  Buffer.from([0x00, 0x00, 0x02, 0x80]), // width 640
  Buffer.from([0x00, 0x00, 0x01, 0xe0]), // height 480
]);

/** 合法 JPEG：SOI + SOF0（height 32 / width 64） */
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00,
]);

/** 合法 WebP（无损 VP8L）：48×32（数据区 = 签名 0x2F + 尺寸位小端） */
const WEBP_VP8L_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1'),
  Buffer.from('VP8L', 'latin1'),
  Buffer.alloc(4),
  Buffer.from([0x2f]), // VP8L 签名字节
  (() => {
    const bits = 47 | (31 << 14); // width-1 | (height-1)<<14
    const b = Buffer.alloc(4);
    b.writeUInt32LE(bits, 0);
    return b;
  })(),
]);

/** 合法 WebP（扩展 VP8X）：64×32 */
const WEBP_VP8X_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1'),
  Buffer.from('VP8X', 'latin1'),
  Buffer.alloc(8), // chunk size + flags
  Buffer.from([0x3f, 0x00, 0x00, 0x1f, 0x00, 0x00]), // width-1=63, height-1=31（24 位小端）
]);

/** 合法 AVIF：ftyp + ispe box（800×600） */
const AVIF_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70]), // ftyp box
  Buffer.from('avif', 'latin1'),
  Buffer.alloc(4),
  Buffer.from([0x00, 0x00, 0x00, 0x14, 0x69, 0x73, 0x70, 0x65]), // ispe box
  Buffer.from([0x00, 0x00, 0x00, 0x00]), // version + flags
  Buffer.from([0x00, 0x00, 0x03, 0x20]), // width 800
  Buffer.from([0x00, 0x00, 0x02, 0x58]), // height 600
]);

function fakeMulterFile(overrides: {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size?: number;
}): Express.Multer.File {
  return {
    buffer: overrides.buffer,
    mimetype: overrides.mimetype,
    originalname: overrides.originalname ?? 'demo.png',
    size: overrides.size ?? overrides.buffer.length,
    fieldname: 'file',
    encoding: '7bit',
    destination: '',
    filename: '',
    path: '',
    stream: null,
  } as unknown as Express.Multer.File;
}

/* ----------------------------- 文件校验 ----------------------------- */

describe('media-file.util（unit）', () => {
  it('validateUpload：放行四种白名单 MIME', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/avif']) {
      expect(() => validateUpload({ mimetype: mime, size: 1024 })).not.toThrow();
    }
  });

  it('validateUpload：拒绝非白名单 MIME（400）', () => {
    expect(() => validateUpload({ mimetype: 'image/gif', size: 1024 })).toThrow(BadRequestException);
    expect(() => validateUpload({ mimetype: '', size: 1024 })).toThrow(BadRequestException);
  });

  it('validateUpload：超过 10MB 上限与空文件均拒绝', () => {
    expect(() =>
      validateUpload({ mimetype: 'image/png', size: MAX_MEDIA_FILE_SIZE + 1 }),
    ).toThrow(BadRequestException);
    expect(() => validateUpload({ mimetype: 'image/png', size: 0 })).toThrow(BadRequestException);
  });

  it('verifyImageSignature：四种格式真实魔数通过；文本/过短内容拒绝', () => {
    expect(verifyImageSignature(PNG_BYTES, 'image/png')).toBe(true);
    expect(verifyImageSignature(JPEG_BYTES, 'image/jpeg')).toBe(true);
    expect(verifyImageSignature(WEBP_VP8L_BYTES, 'image/webp')).toBe(true);
    expect(verifyImageSignature(WEBP_VP8X_BYTES, 'image/webp')).toBe(true);
    expect(verifyImageSignature(AVIF_BYTES, 'image/avif')).toBe(true);
    expect(verifyImageSignature(Buffer.from('<html>x</html>'), 'image/png')).toBe(false);
    expect(verifyImageSignature(Buffer.alloc(4), 'image/png')).toBe(false);
    expect(verifyImageSignature(PNG_BYTES, 'image/gif')).toBe(false);
  });

  it('parseImageDimensions：解析 PNG / JPEG / WebP / AVIF 像素尺寸', () => {
    expect(parseImageDimensions(PNG_BYTES, 'image/png')).toEqual({ width: 640, height: 480 });
    expect(parseImageDimensions(JPEG_BYTES, 'image/jpeg')).toEqual({ width: 64, height: 32 });
    expect(parseImageDimensions(WEBP_VP8L_BYTES, 'image/webp')).toEqual({ width: 48, height: 32 });
    expect(parseImageDimensions(WEBP_VP8X_BYTES, 'image/webp')).toEqual({ width: 64, height: 32 });
    expect(parseImageDimensions(AVIF_BYTES, 'image/avif')).toEqual({ width: 800, height: 600 });
  });
});

/* ----------------------------- 本地存储提供方 ----------------------------- */

describe('LocalStorageProvider（unit）', () => {
  let provider: LocalStorageProvider;
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'media-store-'));
    provider = new LocalStorageProvider({
      rootDir,
      uploadsBaseUrl: 'http://127.0.0.1:4000',
    });
  });

  function physicalPath(storageKey: string): string {
    // storageKey 的 media/ 为逻辑命名空间，物理路径相对媒体根目录
    return path.join(rootDir, storageKey.replace(/^media\//, ''));
  }

  it('upload：落盘并按 media/<年>/<月>/<uuid>.<ext> 生成 storageKey 与 url', async () => {
    const stored = await provider.upload({
      buffer: PNG_BYTES,
      originalName: 'demo.png',
      mimeType: 'image/png',
    });

    expect(stored.storageKey).toMatch(
      /^media\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
    );
    expect(stored.url).toBe(`http://127.0.0.1:4000/uploads/${stored.storageKey}`);
    expect(stored.filename.endsWith('.png')).toBe(true);
    // 物理路径 = <rootDir>/<年>/<月>/<uuid>.ext（media/ 命名空间不落盘）
    expect(existsSync(physicalPath(stored.storageKey))).toBe(true);
    expect(await provider.exists(stored.storageKey)).toBe(true);

    const files = (readdirSync(rootDir, { recursive: true }) as string[]).filter((f) =>
      f.endsWith('.png'),
    );
    expect(files).toHaveLength(1);
    expect(files[0].split(path.sep).join('/')).toBe(stored.storageKey.replace(/^media\//, ''));
  });

  it('upload：拒绝白名单外 MIME（不落盘）', async () => {
    await expect(
      provider.upload({ buffer: PNG_BYTES, originalName: 'x.gif', mimeType: 'image/gif' }),
    ).rejects.toThrow(BadRequestException);
    expect(readdirSync(rootDir)).toHaveLength(0);
  });

  it('getUrl / resolvePath：非法 storageKey（含路径穿越）一律拒绝', () => {
    const attacks = [
      'media/2026/10/../../etc/passwd.png',
      '/etc/passwd',
      'media/2026/10/not-a-uuid.png',
      'media/2026/10/11111111-1111-1111-1111-111111111111.php.exe',
      'products/2026/10/x.png',
    ];
    for (const key of attacks) {
      expect(() => provider.getUrl(key)).toThrow(BadRequestException);
    }
  });

  it('delete：不存在时静默成功；存在时删除文件', async () => {
    await expect(
      provider.delete('media/2026/10/11111111-1111-1111-1111-111111111111.png'),
    ).resolves.toBeUndefined();

    const stored = await provider.upload({
      buffer: PNG_BYTES,
      originalName: 'demo.png',
      mimeType: 'image/png',
    });
    await provider.delete(stored.storageKey);
    expect(existsSync(physicalPath(stored.storageKey))).toBe(false);
    expect(await provider.exists(stored.storageKey)).toBe(false);
  });
});
/* ----------------------------- 媒体服务 ----------------------------- */

const STORED_UUID = '11111111-1111-1111-1111-111111111111';
const STORED_KEY = `media/2026/10/${STORED_UUID}.png`;
const STORED_URL = `http://127.0.0.1:4000/uploads/${STORED_KEY}`;

function makePrismaMock() {
  return {
    mediaAsset: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    productImage: {
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeStorageMock(): StorageProvider {
  return {
    provider: MediaProvider.LOCAL,
    upload: jest.fn().mockResolvedValue({
      storageKey: STORED_KEY,
      filename: `${STORED_UUID}.png`,
      url: STORED_URL,
    }),
    delete: jest.fn().mockResolvedValue(undefined),
    getUrl: jest.fn().mockReturnValue(STORED_URL),
    exists: jest.fn().mockResolvedValue(true),
  } as unknown as StorageProvider;
}

function makeAssetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    filename: `${STORED_UUID}.png`,
    originalName: 'demo.png',
    storageKey: STORED_KEY,
    url: STORED_URL,
    mimeType: 'image/png',
    size: PNG_BYTES.length,
    width: 640,
    height: 480,
    altText: null,
    provider: MediaProvider.LOCAL,
    category: MediaCategory.IMAGE,
    createdBy: 'admin-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never;
}

describe('MediaService（unit）', () => {
  let prisma: PrismaMock;
  let storage: StorageProvider;
  let service: MediaService;

  beforeEach(() => {
    prisma = makePrismaMock();
    prisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    storage = makeStorageMock();
    service = new MediaService(prisma as unknown as PrismaService, storage);
  });

  /* ------------------------- 上传 ------------------------- */

  it('upload：非法 MIME 在 provider 之前被拦截，不落盘不落库', async () => {
    await expect(
      service.upload(fakeMulterFile({ buffer: PNG_BYTES, mimetype: 'image/gif' }), 'admin-1'),
    ).rejects.toThrow(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it('upload：伪造 MIME（文本内容声明 png）触发魔数校验失败（400）', async () => {
    await expect(
      service.upload(
        fakeMulterFile({ buffer: Buffer.from('<html>x</html>'), mimetype: 'image/png' }),
        'admin-1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it('upload：成功落库（provider=LOCAL / category=IMAGE / 尺寸解析 / 原始名清洗）', async () => {
    prisma.mediaAsset.create.mockResolvedValue(makeAssetRow());

    const dto = await service.upload(
      fakeMulterFile({ buffer: PNG_BYTES, mimetype: 'image/png', originalname: '我的 图~片.png' }),
      'admin-1',
    );

    expect(storage.upload).toHaveBeenCalledWith({
      buffer: PNG_BYTES,
      originalName: '我的 图~片.png',
      mimeType: 'image/png',
    });

    const call = prisma.mediaAsset.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({
      filename: `${STORED_UUID}.png`,
      originalName: '我的_图_片.png', // 空格/波浪号被清洗为下划线
      storageKey: STORED_KEY,
      url: STORED_URL,
      mimeType: 'image/png',
      size: PNG_BYTES.length,
      width: 640,
      height: 480,
      category: MediaCategory.IMAGE,
      provider: MediaProvider.LOCAL,
      createdBy: 'admin-1',
    });

    expect(dto).toMatchObject({ id: 'media-1', storageKey: STORED_KEY, url: STORED_URL });
    expect(dto.createdAt).toBe(NOW.toISOString());
  });

  it('upload：原始文件名路径穿越成分被剥离（basename）', async () => {
    prisma.mediaAsset.create.mockResolvedValue(makeAssetRow({ originalName: 'passwd.png' }));

    await service.upload(
      fakeMulterFile({
        buffer: PNG_BYTES,
        mimetype: 'image/png',
        originalname: '../../etc/passwd.png',
      }),
      'admin-1',
    );

    const call = prisma.mediaAsset.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.originalName).toBe('passwd.png');
  });

  /* ------------------------- 查询 ------------------------- */

  it('list：默认分页（page=1, limit=20）返回分页信封', async () => {
    prisma.mediaAsset.count.mockResolvedValue(1);
    prisma.mediaAsset.findMany.mockResolvedValue([makeAssetRow()]);

    const result = await service.list({} as ListMediaQueryDto);

    expect(result).toMatchObject({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(result.items[0]).toMatchObject({ id: 'media-1', url: STORED_URL });
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
  });

  it('list：keyword 生成 originalName/filename 不区分大小写 OR 匹配', async () => {
    prisma.mediaAsset.count.mockResolvedValue(0);
    prisma.mediaAsset.findMany.mockResolvedValue([]);

    await service.list({ keyword: 'demo' } as ListMediaQueryDto);

    expect(prisma.mediaAsset.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { originalName: { contains: 'demo', mode: 'insensitive' } },
          { filename: { contains: 'demo', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('list：category 筛选进入 where；分页参数夹紧（page≥1，limit≤100）', async () => {
    prisma.mediaAsset.count.mockResolvedValue(0);
    prisma.mediaAsset.findMany.mockResolvedValue([]);

    await service.list({ page: 0, limit: 500, category: MediaCategory.IMAGE } as ListMediaQueryDto);

    expect(prisma.mediaAsset.count).toHaveBeenCalledWith({
      where: { category: MediaCategory.IMAGE },
    });
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 100 }),
    );
  });

  it('findById：不存在返回 404；存在返回 DTO', async () => {
    prisma.mediaAsset.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow('媒体资源不存在');

    prisma.mediaAsset.findUnique.mockResolvedValue(makeAssetRow());
    const dto = await service.findById('media-1');
    expect(dto).toMatchObject({ id: 'media-1', width: 640, height: 480 });
  });

  /* ------------------------- 删除与引用检查 ------------------------- */

  it('remove：不存在返回 404', async () => {
    prisma.mediaAsset.findUnique.mockResolvedValue(null);
    await expect(service.remove('missing')).rejects.toThrow('媒体资源不存在');
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('remove：被 ProductImage 引用返回 400 "Media asset is in use."，不删行不删文件', async () => {
    prisma.mediaAsset.findUnique.mockResolvedValue(makeAssetRow());
    prisma.productImage.count.mockResolvedValue(1);

    await expect(service.remove('media-1')).rejects.toThrow('Media asset is in use.');
    expect(prisma.mediaAsset.delete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();

    // 引用匹配：url 精确 + 文件名后缀双匹配（兼容未来 CDN 基地址变化）
    expect(prisma.productImage.count).toHaveBeenCalledWith({
      where: {
        OR: [{ url: STORED_URL }, { url: { endsWith: `/${STORED_UUID}.png` } }],
      },
    });
  });

  it('remove：未被引用时先删数据库行再委托 StorageProvider 删文件', async () => {
    prisma.mediaAsset.findUnique.mockResolvedValue(makeAssetRow());
    prisma.productImage.count.mockResolvedValue(0);
    prisma.mediaAsset.delete.mockResolvedValue(makeAssetRow());

    await expect(service.remove('media-1')).resolves.toEqual({ id: 'media-1' });

    expect(prisma.mediaAsset.delete).toHaveBeenCalledWith({ where: { id: 'media-1' } });
    expect(storage.delete).toHaveBeenCalledWith(STORED_KEY);
  });
});
