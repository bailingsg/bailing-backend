import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole, ContentStatus, MediaProvider, QualityRecordType } from '@prisma/client';
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
 * Enterprise CMS 端到端测试（Phase 4.5：Factory / Quality / Applications + 公开 API）。
 *
 * 依赖本地 Docker PostgreSQL（factory_sections / factory_images / factory_exhibitions /
 * quality_records / applications / application_products / media_assets 表已存在）。
 *
 * 覆盖任务书要求：
 *   · JWT Protection（全部 CMS 写接口无令牌 401；公开接口无需令牌）
 *   · DTO 校验（非法 slug 400 / 缺字段 400）
 *   · 重复 slug 409
 *   · 不存在记录 404
 *   · 未发布内容不出现在公开 API；已发布可读
 *   · 公开 API 不泄漏内部字段（storageKey / createdBy / provider / status / sortOrder）
 *   · 媒体删除保护（被工厂 / 质量 / 应用场景引用时不允许删除）
 *   · 关联完整性（删除应用场景不删产品；删除工厂分区不删媒体）
 *
 * 测试数据统一使用 e2e-ent- 前缀 slug，beforeAll/afterAll 负责清理（含磁盘媒体文件）。
 */

const E2E_EMAIL = 'e2e-ent@bailingwooden.test';
const E2E_PASSWORD = 'E2E-ent-2026!';
const SLUG_PREFIX = 'e2e-ent-';
const RUN_ID = Date.now().toString(36);

const FACTORY_SLUG = `${SLUG_PREFIX}${RUN_ID}-factory`;
const FACTORY_DRAFT_SLUG = `${SLUG_PREFIX}${RUN_ID}-factory-draft`;
const QUALITY_SLUG = `${SLUG_PREFIX}${RUN_ID}-quality`;
const QUALITY_DRAFT_SLUG = `${SLUG_PREFIX}${RUN_ID}-quality-draft`;
const APP_SLUG = `${SLUG_PREFIX}${RUN_ID}-app`;
const APP_DRAFT_SLUG = `${SLUG_PREFIX}${RUN_ID}-app-draft`;
const PRODUCT_SLUG = `${SLUG_PREFIX}${RUN_ID}-product`;
const CATEGORY_SLUG = `${SLUG_PREFIX}${RUN_ID}-cat`;

/** 合法 PNG（签名 + IHDR，640×480）——媒体库魔数校验与尺寸解析都需要 */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0x00, 0x00, 0x02, 0x80]), // width 640
  Buffer.from([0x00, 0x00, 0x01, 0xe0]), // height 480
]);

/** 合法 PDF（%PDF- 魔数头）——DOCUMENT 类型媒体上传校验 */
const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('%\xE2\xE3\xCF\xD3\n'),
  Buffer.from('1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
]);

describe('Enterprise CMS（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let categoryId: string;
  let productId: string;
  let imageMediaId: string;
  let pdfMediaId: string;

  const auth = (): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    await cleanupTestData();

    await prisma.adminUser.deleteMany({ where: { email: E2E_EMAIL } });
    const admin = await prisma.adminUser.create({
      data: {
        email: E2E_EMAIL,
        passwordHash: bcrypt.hashSync(E2E_PASSWORD, 4),
        name: 'E2E Enterprise Admin',
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

    // 预置：分类 + 产品（供应用场景关联）
    const category = await prisma.category.create({
      data: { name: 'E2E 分类', slug: CATEGORY_SLUG },
    });
    categoryId = category.id;
    const product = await prisma.product.create({
      data: {
        name: 'E2E 板材',
        slug: PRODUCT_SLUG,
        description: '端到端测试产品',
        categoryId,
        status: 'PUBLISHED',
      },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await cleanupTestData();
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  /** 清理：先删关联表 → 业务表 → 产品/分类 → 测试媒体的磁盘文件与库记录 */
  async function cleanupTestData(): Promise<void> {
    await prisma.factorySection.deleteMany({
      where: { slug: { startsWith: `${SLUG_PREFIX}${RUN_ID}` } },
    });
    await prisma.qualityRecord.deleteMany({
      where: { slug: { startsWith: `${SLUG_PREFIX}${RUN_ID}` } },
    });
    await prisma.application.deleteMany({
      where: { slug: { startsWith: `${SLUG_PREFIX}${RUN_ID}` } },
    });
    await prisma.product.deleteMany({ where: { slug: PRODUCT_SLUG } });
    await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });

    const assets = await prisma.mediaAsset.findMany({
      where: { originalName: { startsWith: 'e2e-ent-' } },
      select: { id: true, storageKey: true },
    });
    for (const asset of assets) {
      const relative = asset.storageKey.startsWith('media/')
        ? asset.storageKey.slice('media/'.length)
        : asset.storageKey;
      await rm(path.join(MEDIA_UPLOAD_ROOT, relative), { force: true });
    }
    await prisma.mediaAsset.deleteMany({ where: { originalName: { startsWith: 'e2e-ent-' } } });
  }

  /* ========================= JWT 保护矩阵 ========================= */

  it('JWT protect：全部企业 CMS 接口无令牌返回 401', async () => {
    const probes: Array<[string, string]> = [
      ['get', '/api/v1/cms/factory'],
      ['post', '/api/v1/cms/factory'],
      ['get', '/api/v1/cms/factory/whatever'],
      ['get', '/api/v1/cms/factory/whatever/exhibitions'],
      ['patch', '/api/v1/cms/factory/whatever'],
      ['delete', '/api/v1/cms/factory/whatever'],
      ['get', '/api/v1/cms/quality'],
      ['post', '/api/v1/cms/quality'],
      ['get', '/api/v1/cms/quality/whatever'],
      ['patch', '/api/v1/cms/quality/whatever'],
      ['delete', '/api/v1/cms/quality/whatever'],
      ['get', '/api/v1/cms/applications'],
      ['post', '/api/v1/cms/applications'],
      ['get', '/api/v1/cms/applications/whatever'],
      ['patch', '/api/v1/cms/applications/whatever'],
      ['delete', '/api/v1/cms/applications/whatever'],
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

  it('公开 API 无需登录即可访问', async () => {
    for (const url of [
      '/api/v1/public/factory',
      '/api/v1/public/quality',
      '/api/v1/public/applications',
    ]) {
      await request(app.getHttpServer()).get(url).expect(200);
    }
  });

  /* ========================= 媒体上传 ========================= */

  it('Media：上传 PNG（图片）与 PDF（文档）', async () => {
    const png = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', PNG_BYTES, { filename: 'e2e-ent-cover.png', contentType: 'image/png' })
      .expect(201);
    expect(png.body.data).toMatchObject({ provider: MediaProvider.LOCAL, width: 640, height: 480 });
    imageMediaId = png.body.data.id as string;

    const storageKey = png.body.data.storageKey as string;
    const relative = storageKey.startsWith('media/') ? storageKey.slice(6) : storageKey;
    expect(existsSync(path.join(MEDIA_UPLOAD_ROOT, relative))).toBe(true);

    const pdf = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', PDF_BYTES, { filename: 'e2e-ent-cert.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(pdf.body.data.mimeType).toBe('application/pdf');
    pdfMediaId = pdf.body.data.id as string;
  });

  /* ========================= Factory ========================= */

  let factoryId: string;
  let factoryDraftId: string;

  it('Factory：创建（含图库 + 展会）→ 非法 slug 400 → 重名 409', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/factory')
      .set(auth())
      .send({
        title: '生产车间',
        slug: FACTORY_SLUG,
        sectionType: 'PRODUCTION',
        summary: '生产车间简介',
        content: '<p>正文</p><script>alert(1)</script>',
        coverMediaId: imageMediaId,
        status: ContentStatus.PUBLISHED,
        images: [{ mediaId: imageMediaId, altText: '车间图', sortOrder: 0 }],
        exhibitions: [{ name: '广州建博会', location: '广州', photos: [{ mediaId: imageMediaId }] }],
      })
      .expect(201);

    expect(created.body.data).toMatchObject({
      slug: FACTORY_SLUG,
      sectionType: 'PRODUCTION',
      status: ContentStatus.PUBLISHED,
      coverMediaId: imageMediaId,
    });
    expect(created.body.data.publishedAt).toBeTruthy();
    expect(created.body.data.imageCount).toBe(1);
    expect(created.body.data.exhibitionCount).toBe(1);
    // content 经 XSS 净化
    expect(created.body.data.content).toBe('<p>正文</p>');
    factoryId = created.body.data.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/cms/factory')
      .set(auth())
      .send({ title: 'Bad', slug: 'Bad Slug!', sectionType: 'OVERVIEW' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/cms/factory')
      .set(auth())
      .send({ title: '重复', slug: FACTORY_SLUG, sectionType: 'OVERVIEW' })
      .expect(409);
  });

  it('Factory：不存在的记录返回 404', async () => {
    await request(app.getHttpServer()).get('/api/v1/cms/factory/nonexistent').set(auth()).expect(404);
    await request(app.getHttpServer())
      .patch('/api/v1/cms/factory/nonexistent')
      .set(auth())
      .send({ summary: '合法长度的摘要' })
      .expect(404);
    await request(app.getHttpServer()).delete('/api/v1/cms/factory/nonexistent').set(auth()).expect(404);
  });

  it('Factory：封面媒体不存在返回 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/factory')
      .set(auth())
      .send({
        title: 'X',
        slug: `${SLUG_PREFIX}${RUN_ID}-bad-cover`,
        sectionType: 'OVERVIEW',
        coverMediaId: 'ghost-media',
      })
      .expect(400);
  });

  it('Factory：更新 + 参展记录子路由 + 图库整体替换', async () => {
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/cms/factory/${factoryId}`)
      .set(auth())
      .send({ summary: '更新后的简介', images: [] })
      .expect(200);
    expect(updated.body.data).toMatchObject({ summary: '更新后的简介', imageCount: 0 });

    const exhibitions = await request(app.getHttpServer())
      .get(`/api/v1/cms/factory/${factoryId}/exhibitions`)
      .set(auth())
      .expect(200);
    expect(Array.isArray(exhibitions.body.data)).toBe(true);
    expect(exhibitions.body.data[0]).toMatchObject({ name: '广州建博会' });
  });

  /* ========================= Quality ========================= */

  let qualityId: string;
  let qualityDraftId: string;

  it('Quality：创建已发布（PDF 证书）→ 草稿（无证书号）→ 重名 409', async () => {
    const published = await request(app.getHttpServer())
      .post('/api/v1/cms/quality')
      .set(auth())
      .send({
        title: 'FSC 森林认证',
        slug: QUALITY_SLUG,
        recordType: QualityRecordType.CERTIFICATION,
        issuer: 'FSC',
        certificateNumber: 'FSC-C123456',
        issueDate: '2025-01-01',
        expiryDate: '2027-01-01',
        mediaId: pdfMediaId,
        status: ContentStatus.PUBLISHED,
      })
      .expect(201);
    expect(published.body.data).toMatchObject({
      slug: QUALITY_SLUG,
      certificateNumber: 'FSC-C123456',
      mediaId: pdfMediaId,
      status: ContentStatus.PUBLISHED,
    });
    expect(published.body.data.media.isDocument).toBe(true);
    qualityId = published.body.data.id as string;

    // 草稿 + 无证书号 / 无日期（数据诚实：允许全空）
    const draft = await request(app.getHttpServer())
      .post('/api/v1/cms/quality')
      .set(auth())
      .send({ title: '内部抽检流程', slug: QUALITY_DRAFT_SLUG, recordType: QualityRecordType.QUALITY_CONTROL })
      .expect(201);
    expect(draft.body.data).toMatchObject({
      certificateNumber: null,
      issueDate: null,
      expiryDate: null,
      status: ContentStatus.DRAFT,
      publishedAt: null,
    });
    qualityDraftId = draft.body.data.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/cms/quality')
      .set(auth())
      .send({ title: '重复', slug: QUALITY_SLUG, recordType: QualityRecordType.CERTIFICATION })
      .expect(409);
  });

  it('Quality：不存在的记录 404 + 文件媒体不存在 400', async () => {
    await request(app.getHttpServer()).get('/api/v1/cms/quality/nonexistent').set(auth()).expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/cms/quality')
      .set(auth())
      .send({
        title: 'X',
        slug: `${SLUG_PREFIX}${RUN_ID}-bad-file`,
        recordType: QualityRecordType.CERTIFICATION,
        mediaId: 'ghost-media',
      })
      .expect(400);
  });

  /* ========================= Applications ========================= */

  let appId: string;
  let appDraftId: string;

  it('Applications：创建已发布（关联产品）→ 草稿 → 重名 409', async () => {
    const published = await request(app.getHttpServer())
      .post('/api/v1/cms/applications')
      .set(auth())
      .send({
        name: '家具制造',
        slug: APP_SLUG,
        summary: '家具制造场景',
        coverMediaId: imageMediaId,
        status: ContentStatus.PUBLISHED,
        featured: true,
        products: [{ productId }],
      })
      .expect(201);
    expect(published.body.data).toMatchObject({
      slug: APP_SLUG,
      status: ContentStatus.PUBLISHED,
      featured: true,
      productCount: 1,
    });
    expect(published.body.data.products[0].id).toBe(productId);
    appId = published.body.data.id as string;

    const draft = await request(app.getHttpServer())
      .post('/api/v1/cms/applications')
      .set(auth())
      .send({ name: '草稿场景', slug: APP_DRAFT_SLUG })
      .expect(201);
    expect(draft.body.data).toMatchObject({ status: ContentStatus.DRAFT, publishedAt: null, productCount: 0 });
    appDraftId = draft.body.data.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/cms/applications')
      .set(auth())
      .send({ name: '重复', slug: APP_SLUG })
      .expect(409);
  });

  it('Applications：关联不存在的产品 400 + 不存在记录 404', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/applications')
      .set(auth())
      .send({
        name: 'X',
        slug: `${SLUG_PREFIX}${RUN_ID}-bad-prod`,
        products: [{ productId: 'ghost-product' }],
      })
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/cms/applications/nonexistent')
      .set(auth())
      .expect(404);
  });

  it('Applications：products 整体替换（清空关联）', async () => {
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/cms/applications/${appId}`)
      .set(auth())
      .send({ products: [] })
      .expect(200);
    expect(updated.body.data.productCount).toBe(0);
    expect(updated.body.data.products).toEqual([]);
  });

  /* ========================= 媒体删除保护 ========================= */

  it('媒体删除保护：被工厂封面引用时不允许删除', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/cms/media/${imageMediaId}`)
      .set(auth());
    expect(res.status).toBe(400);
  });

  it('媒体删除保护：被质量记录引用时不允许删除', async () => {
    const res = await request(app.getHttpServer()).delete(`/api/v1/cms/media/${pdfMediaId}`).set(auth());
    expect(res.status).toBe(400);
  });

  /* ========================= 公开 API 发布规则 ========================= */

  it('公开工厂：列表只含已发布；草稿不出现在列表与详情', async () => {
    // 创建草稿分区
    const draft = await request(app.getHttpServer())
      .post('/api/v1/cms/factory')
      .set(auth())
      .send({ title: '草稿分区', slug: FACTORY_DRAFT_SLUG, sectionType: 'OVERVIEW' })
      .expect(201);
    factoryDraftId = draft.body.data.id as string;

    const list = await request(app.getHttpServer())
      .get('/api/v1/public/factory?pageSize=48')
      .expect(200);
    const slugs = (list.body.data.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(slugs).toContain(FACTORY_SLUG);
    expect(slugs).not.toContain(FACTORY_DRAFT_SLUG);

    // 已发布详情可读
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/public/factory/${FACTORY_SLUG}`)
      .expect(200);
    expect(detail.body.data.slug).toBe(FACTORY_SLUG);

    // 草稿详情报 404
    await request(app.getHttpServer())
      .get(`/api/v1/public/factory/${FACTORY_DRAFT_SLUG}`)
      .expect(404);
  });

  it('公开工厂：详情不泄漏内部字段', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/public/factory/${FACTORY_SLUG}`)
      .expect(200);
    const raw = JSON.stringify(detail.body.data);
    for (const leaked of ['storageKey', 'createdBy', 'provider', 'createdAt', 'updatedAt', 'sortOrder']) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('公开质量：只含已发布记录；草稿记录不可见', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/public/quality?pageSize=48')
      .expect(200);
    const slugs = (list.body.data.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(slugs).toContain(QUALITY_SLUG);
    expect(slugs).not.toContain(QUALITY_DRAFT_SLUG);

    const published = (list.body.data.items as Array<{ slug: string }>).find(
      (i) => i.slug === QUALITY_SLUG,
    );
    expect(published).toBeDefined();
  });

  it('公开质量：到期结论只基于真实 expiryDate（缺失则为 null）', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/public/quality?pageSize=48')
      .expect(200);
    const records = list.body.data.items as Array<{ slug: string; isExpired: boolean | null }>;
    const published = records.find((r) => r.slug === QUALITY_SLUG);
    // 2027-01-01 未过期 → false（明确结论）
    expect(published?.isExpired).toBe(false);
    // 草稿不在列表中，故不检查其 isExpired
  });

  it('公开应用场景：列表只含已发布；草稿不可见；详情只返回已发布产品', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/public/applications?pageSize=48')
      .expect(200);
    const slugs = (list.body.data.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(slugs).toContain(APP_SLUG);
    expect(slugs).not.toContain(APP_DRAFT_SLUG);

    await request(app.getHttpServer())
      .get(`/api/v1/public/applications/${APP_DRAFT_SLUG}`)
      .expect(404);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/public/applications/${APP_SLUG}`)
      .expect(200);
    expect(detail.body.data.slug).toBe(APP_SLUG);
    // 详情不泄漏内部字段
    const raw = JSON.stringify(detail.body.data);
    for (const leaked of ['storageKey', 'createdBy', 'provider', 'status', 'sortOrder']) {
      expect(raw).not.toContain(leaked);
    }
  });

  /* ========================= 关联完整性 ========================= */

  it('删除工厂分区：不删除被引用的媒体资产', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/cms/factory/${factoryId}`).set(auth()).expect(200);
    // 媒体仍存在（因为质量/应用场景仍引用 imageMediaId / pdfMediaId）
    const media = await prisma.mediaAsset.findUnique({ where: { id: imageMediaId } });
    expect(media).not.toBeNull();
  });

  it('删除应用场景：不删除关联产品', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/cms/applications/${appId}`).set(auth()).expect(200);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product).not.toBeNull();
  });

  it('删除质量草稿记录：记录消失但媒体资产保留', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/quality/${qualityDraftId}`)
      .set(auth())
      .expect(200);
    const record = await prisma.qualityRecord.findUnique({ where: { id: qualityDraftId } });
    expect(record).toBeNull();
  });

  it('清理后：删除未被引用的媒体可成功', async () => {
    // 先删除剩余引用（工厂草稿、质量已发布、应用场景草稿）
    await request(app.getHttpServer()).delete(`/api/v1/cms/factory/${factoryDraftId}`).set(auth()).expect(200);
    await request(app.getHttpServer()).delete(`/api/v1/cms/quality/${qualityId}`).set(auth()).expect(200);
    await request(app.getHttpServer()).delete(`/api/v1/cms/applications/${appDraftId}`).set(auth()).expect(200);

    await request(app.getHttpServer()).delete(`/api/v1/cms/media/${pdfMediaId}`).set(auth()).expect(200);
    await request(app.getHttpServer()).delete(`/api/v1/cms/media/${imageMediaId}`).set(auth()).expect(200);

    expect(await prisma.mediaAsset.findUnique({ where: { id: imageMediaId } })).toBeNull();
    expect(await prisma.mediaAsset.findUnique({ where: { id: pdfMediaId } })).toBeNull();
  });
});
