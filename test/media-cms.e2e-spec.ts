import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';
import { MEDIA_UPLOAD_ROOT } from '../src/modules/media/media.module';

/**
 * Media CMS 端到端测试（Phase 4.3）。
 *
 * 依赖本地 Docker PostgreSQL（media_assets / product_images 表已存在）。
 * 覆盖任务书要求：JWT Protection / Upload（真 PNG、伪造 MIME、超限、缺字段）/
 * Media CRUD / File Validation / Reference Check（被 ProductImage 引用 → 400）。
 *
 * 测试数据统一使用 e2e-media- 前缀（originalName / product slug），
 * beforeAll/afterAll 负责清理（含磁盘媒体文件，不留垃圾）。
 */

const E2E_EMAIL = 'e2e-media@bailingwooden.test';
const E2E_PASSWORD = 'E2E-pass-2026!';
const SLUG_PREFIX = 'e2e-media-';
const ORIGINAL_PREFIX = 'e2e-media-';
const RUN_ID = Date.now().toString(36);

/** 合法 PNG：640×480（签名 + IHDR，魔数与尺寸解析都必须通过） */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]), // IHDR
  Buffer.from([0x00, 0x00, 0x02, 0x80]), // width 640
  Buffer.from([0x00, 0x00, 0x01, 0xe0]), // height 480
]);

/** storageKey（media/<年>/<月>/uuid.ext）→ 物理路径（media/ 为逻辑命名空间，不落盘） */
function mediaPhysicalPath(storageKey: string): string {
  return path.join(MEDIA_UPLOAD_ROOT, storageKey.replace(/^media\//, ''));
}

describe('Media CMS（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let uploadsBase: string;
  let assetId: string;
  let assetUrl: string;
  let assetKey: string;

  const auth = (): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // .env 已在 ConfigModule 初始化时注入 process.env（局域网联调为 LAN IP）
    uploadsBase = (process.env.UPLOADS_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

    // 预清理：历史残留（含磁盘文件）
    await cleanupTestData();

    // 专用测试管理员（低成本哈希，测试后删除）
    await prisma.adminUser.deleteMany({ where: { email: E2E_EMAIL } });
    const admin = await prisma.adminUser.create({
      data: {
        email: E2E_EMAIL,
        passwordHash: bcrypt.hashSync(E2E_PASSWORD, 4),
        name: 'E2E Media Admin',
        role: AdminRole.ADMIN,
        isActive: true,
      },
    });
    adminId = admin.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: E2E_EMAIL, password: E2E_PASSWORD })
      .expect(200);
    token = login.body.data.accessToken as string;
  });

  afterAll(async () => {
    await cleanupTestData();
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  /** 清理 e2e-media- 前缀的产品（级联图片行）、媒体资产（含磁盘文件）、分类 */
  async function cleanupTestData(): Promise<void> {
    await prisma.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });

    const assets = await prisma.mediaAsset.findMany({
      where: { originalName: { startsWith: ORIGINAL_PREFIX } },
      select: { storageKey: true },
    });
    for (const asset of assets) {
      await rm(mediaPhysicalPath(asset.storageKey), { force: true });
    }
    await prisma.mediaAsset.deleteMany({
      where: { originalName: { startsWith: ORIGINAL_PREFIX } },
    });
  }

  /* ------------------------- JWT 保护矩阵 ------------------------- */

  it('JWT protect：全部 Media 接口无令牌返回 401', async () => {
    const probes: Array<[string, string]> = [
      ['get', '/api/v1/cms/media'],
      ['post', '/api/v1/cms/media/upload'],
      ['get', '/api/v1/cms/media/whatever'],
      ['delete', '/api/v1/cms/media/whatever'],
    ];

    const http = request(app.getHttpServer()) as unknown as Record<
      string,
      (url: string) => Promise<{ status: number }>
    >;

    for (const [method, url] of probes) {
      const res = await http[method](url);
      expect(res.status).toBe(401);
    }
  });

  it('JWT protect：伪造令牌返回 401', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/cms/media')
      .set('Authorization', 'Bearer forged.token.value')
      .expect(401);
  });

  /* ------------------------- 上传 ------------------------- */

  it('Upload：合法 PNG 返回 201，落库（provider/category/尺寸）且文件可经 /uploads/media 静态访问', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', PNG_BYTES, {
        filename: 'e2e-media-demo.png',
        contentType: 'image/png',
      })
      .expect(201);

    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data).toMatchObject({
      filename: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
      ),
      originalName: 'e2e-media-demo.png',
      mimeType: 'image/png',
      size: PNG_BYTES.length,
      width: 640,
      height: 480,
      category: 'IMAGE',
      provider: 'LOCAL',
      createdBy: adminId,
    });
    expect(data.storageKey).toMatch(/^media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(data.url).toBe(
      `${uploadsBase}/uploads/media/${(data.storageKey as string).replace(/^media\//, '')}`,
    );

    assetId = data.id as string;
    assetUrl = data.url as string;
    assetKey = data.storageKey as string;

    // 文件真实落盘（物理路径剥离开逻辑命名空间）
    expect(existsSync(mediaPhysicalPath(assetKey))).toBe(true);
    // 经静态路由可读
    await request(app.getHttpServer()).get(`/uploads/media/${assetKey.replace(/^media\//, '')}`).expect(200);
  });

  it('Upload：伪造 MIME（文本内容声明 image/png）返回 400 且不落盘不落库', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', Buffer.from('<html>not an image</html>'), {
        filename: 'e2e-media-fake.png',
        contentType: 'image/png',
      })
      .expect(400);

    expect(res.body.success).toBe(false);
    // Phase 4.5：错误文案已扩展为「支持 jpeg / png / webp / avif / pdf」
    expect(String(res.body.error.message)).toContain('文件内容与声明格式不符');
    expect(existsSync(mediaPhysicalPath(assetKey))).toBe(true); // 已有资产不受影响
  });

  it('Upload：非图片 MIME（text/plain）被前置校验拒绝（400）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', Buffer.from('plain text'), {
        filename: 'e2e-media-note.txt',
        contentType: 'text/plain',
      })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it('Upload：超过 10MB 上限返回 413（multer limits 经平台层映射 PayloadTooLarge）', async () => {
    const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x41);
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', tooLarge, {
        filename: 'e2e-media-huge.png',
        contentType: 'image/png',
      })
      .expect(413);

    expect(res.body.success).toBe(false);
    expect(String(res.body.error.message).toLowerCase()).toContain('large');

    // 超限文件不落盘不落库
    const count = await prisma.mediaAsset.count({
      where: { originalName: 'e2e-media-huge.png' },
    });
    expect(count).toBe(0);
  });

  it('Upload：缺少 file 字段返回 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .field('note', 'no file attached')
      .expect(400);
  });

  /* ------------------------- 列表 / 详情 ------------------------- */

  it('List：分页信封 + keyword 筛选（originalName）+ category 筛选', async () => {
    // 第二个资产（用于 keyword 区分）
    const second = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', PNG_BYTES, {
        filename: 'e2e-media-second-keyword.png',
        contentType: 'image/png',
      })
      .expect(201);
    const secondId = second.body.data.id as string;

    const all = await request(app.getHttpServer()).get('/api/v1/cms/media').set(auth()).expect(200);
    expect(all.body.success).toBe(true);
    expect(all.body.data).toMatchObject({ page: 1, limit: 20 });
    expect((all.body.data.items as Array<{ id: string }>).length).toBeGreaterThanOrEqual(2);

    const filtered = await request(app.getHttpServer())
      .get('/api/v1/cms/media')
      .query({ keyword: 'second-keyword' })
      .set(auth())
      .expect(200);
    const items = filtered.body.data.items as Array<{ id: string; originalName: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(secondId);

    const byCategory = await request(app.getHttpServer())
      .get('/api/v1/cms/media')
      .query({ category: 'IMAGE', limit: 1 })
      .set(auth())
      .expect(200);
    expect(byCategory.body.data.limit).toBe(1);

    // 清理第二个资产（直接删，删除前确认无引用）
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/media/${secondId}`)
      .set(auth())
      .expect(200);
  });

  it('List：referenced 筛选（未被引用仅 referenced=false 可见；被 ProductImage 引用后反转）', async () => {
    // 第三个资产：初始未被任何业务记录引用
    const third = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', PNG_BYTES, {
        filename: 'e2e-media-third-unref.png',
        contentType: 'image/png',
      })
      .expect(201);
    const thirdId = third.body.data.id as string;
    const thirdUrl = third.body.data.url as string;
    // 上传响应即带引用计数（新资产 = 0）
    expect(third.body.data.referenceCount).toBe(0);

    const unreferencedBefore = await request(app.getHttpServer())
      .get('/api/v1/cms/media')
      .query({ referenced: 'false', keyword: 'third-unref' })
      .set(auth())
      .expect(200);
    const itemsBefore = unreferencedBefore.body.data.items as Array<{
      id: string;
      referenceCount: number;
    }>;
    expect(itemsBefore).toHaveLength(1);
    expect(itemsBefore[0]).toMatchObject({ id: thirdId, referenceCount: 0 });

    // 尚未被引用：referenced=true 视图为空
    const referencedBefore = await request(app.getHttpServer())
      .get('/api/v1/cms/media')
      .query({ referenced: 'true', keyword: 'third-unref' })
      .set(auth())
      .expect(200);
    expect(referencedBefore.body.data.items).toHaveLength(0);

    // 建立引用（产品图片 url 快照），筛选结果反转
    const category = await prisma.category.create({
      data: { name: 'E2E Media Ref Cat', slug: `${SLUG_PREFIX}${RUN_ID}-ref-cat` },
    });
    const product = await prisma.product.create({
      data: {
        name: 'E2E Media Ref Holder',
        slug: `${SLUG_PREFIX}${RUN_ID}-ref-holder`,
        categoryId: category.id,
        description: 'holder product for media referenced filter',
        status: 'DRAFT',
        isFeatured: false,
      },
    });
    await prisma.productImage.create({
      data: { productId: product.id, url: thirdUrl },
    });

    const referencedAfter = await request(app.getHttpServer())
      .get('/api/v1/cms/media')
      .query({ referenced: 'true', keyword: 'third-unref' })
      .set(auth())
      .expect(200);
    const itemsAfter = referencedAfter.body.data.items as Array<{
      id: string;
      referenceCount: number;
    }>;
    expect(itemsAfter).toHaveLength(1);
    expect(itemsAfter[0]).toMatchObject({ id: thirdId, referenceCount: 1 });

    const unreferencedAfter = await request(app.getHttpServer())
      .get('/api/v1/cms/media')
      .query({ referenced: 'false', keyword: 'third-unref' })
      .set(auth())
      .expect(200);
    expect(unreferencedAfter.body.data.items).toHaveLength(0);

    // 清理：产品级联删图片行 → 资产不再被引用 → 可直接删除
    await prisma.product.delete({ where: { id: product.id } });
    await prisma.category.delete({ where: { id: category.id } });
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/media/${thirdId}`)
      .set(auth())
      .expect(200);
  });

  it('Detail：存在返回 200；不存在返回 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/cms/media/${assetId}`)
      .set(auth())
      .expect(200);
    expect(res.body.data).toMatchObject({ id: assetId, url: assetUrl });

    await request(app.getHttpServer())
      .get('/api/v1/cms/media/not-exist-media')
      .set(auth())
      .expect(404);
  });

  /* ------------------------- 引用检查 ------------------------- */

  it('Reference Check：被 ProductImage 引用时删除返回 400 "Media asset is in use."', async () => {
    // 引用当前媒体 URL 的产品（经 prisma 直建，删除产品时级联清理图片行）
    const category = await prisma.category.create({
      data: { name: 'E2E Media Holder Cat', slug: `${SLUG_PREFIX}${RUN_ID}-cat` },
    });
    const product = await prisma.product.create({
      data: {
        name: 'E2E Media Holder',
        slug: `${SLUG_PREFIX}${RUN_ID}-holder`,
        categoryId: category.id,
        description: 'holder product for media reference check',
        status: 'DRAFT',
        isFeatured: false,
      },
    });
    await prisma.productImage.create({
      data: { productId: product.id, url: assetUrl },
    });

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/cms/media/${assetId}`)
      .set(auth())
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toBe('Media asset is in use.');

    // 数据库行与磁盘文件都未被删除
    const stillThere = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    expect(stillThere).not.toBeNull();
    expect(existsSync(mediaPhysicalPath(assetKey))).toBe(true);

    // 解除引用后删除成功（产品级联删图片行，分类留待 afterAll 清理）
    await prisma.product.delete({ where: { id: product.id } });
  });

  it('Delete：未被引用时返回 200，数据库行与磁盘文件均被删除', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/cms/media/${assetId}`)
      .set(auth())
      .expect(200);
    expect(res.body.data).toEqual({ id: assetId });

    const gone = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    expect(gone).toBeNull();
    expect(existsSync(mediaPhysicalPath(assetKey))).toBe(false);

    // 重复删除返回 404
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/media/${assetId}`)
      .set(auth())
      .expect(404);
  });
});
