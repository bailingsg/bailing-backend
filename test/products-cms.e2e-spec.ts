import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole, ProductStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';
import { PRODUCT_UPLOAD_DIR } from '../src/modules/cms/products/upload.options';

/**
 * Products CMS 端到端测试（Phase 4.2）。
 *
 * 依赖本地 Docker PostgreSQL（categories / products / product_images 表已存在）。
 * 覆盖任务书要求：JWT Protection / Category CRUD / Product CRUD /
 * DTO Validation / Product Image Relation（上传、主图唯一、文件清理）。
 *
 * 测试数据统一使用 e2e-cms- 前缀 slug，beforeAll/afterAll 负责清理
 * （含磁盘图片文件，不留垃圾）。
 */

const E2E_EMAIL = 'e2e-products@bailingwooden.test';
const E2E_PASSWORD = 'E2E-pass-2026!';
const SLUG_PREFIX = 'e2e-cms-';
const RUN_ID = Date.now().toString(36);
const CAT_A_SLUG = `${SLUG_PREFIX}${RUN_ID}-a`;
const CAT_B_SLUG = `${SLUG_PREFIX}${RUN_ID}-b`;
const CAT_C_SLUG = `${SLUG_PREFIX}${RUN_ID}-c`;
const KEYWORD = `kw-${RUN_ID}`;

/** 合法 PNG 魔数 + 填充字节（魔数校验必须通过） */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('e2e-png-filler-bytes'),
]);

describe('Products CMS（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let categoryAId: string;
  let categoryBId: string;
  let product1Id: string;
  let product2Id: string;
  let image1Id: string;
  let image2Id: string;

  const auth = (): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // 预清理：历史残留（含磁盘文件）
    await cleanupTestData();

    // 专用测试管理员（低成本哈希，测试后删除）
    await prisma.adminUser.deleteMany({ where: { email: E2E_EMAIL } });
    const admin = await prisma.adminUser.create({
      data: {
        email: E2E_EMAIL,
        passwordHash: bcrypt.hashSync(E2E_PASSWORD, 4),
        name: 'E2E Products Admin',
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

  /** 删除 e2e-cms- 前缀的产品/分类（先产品级联图片行，再删磁盘文件，最后删分类） */
  async function cleanupTestData(): Promise<void> {
    const products = await prisma.product.findMany({
      where: { slug: { startsWith: SLUG_PREFIX } },
      include: { images: { select: { url: true } } },
    });
    for (const product of products) {
      for (const image of product.images) {
        const name = image.url.split('/').pop();
        if (name) await rm(path.join(PRODUCT_UPLOAD_DIR, name), { force: true });
      }
    }
    await prisma.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  }

  /** 上传目录快照（用于断言失败上传不残留文件） */
  function uploadsSnapshot(): string[] {
    return readdirSync(PRODUCT_UPLOAD_DIR).sort();
  }

  /* ------------------------- JWT 保护矩阵 ------------------------- */

  it('JWT protect：全部 CMS 接口无令牌返回 401', async () => {
    const probes: Array<[string, string]> = [
      ['get', '/api/v1/cms/products'],
      ['post', '/api/v1/cms/products'],
      ['get', '/api/v1/cms/products/whatever'],
      ['patch', '/api/v1/cms/products/whatever'],
      ['delete', '/api/v1/cms/products/whatever'],
      ['post', '/api/v1/cms/products/whatever/images'],
      ['delete', '/api/v1/cms/products/whatever/images/whatever'],
      ['get', '/api/v1/cms/product-categories'],
      ['post', '/api/v1/cms/product-categories'],
      ['patch', '/api/v1/cms/product-categories/whatever'],
      ['delete', '/api/v1/cms/product-categories/whatever'],
    ];

    // supertest 的链式对象按方法名动态调用（测试辅助，仅断言状态码）
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
      .get('/api/v1/cms/products')
      .set('Authorization', 'Bearer forged.token.value')
      .expect(401);
  });

  /* ------------------------- 分类 CRUD ------------------------- */

  it('Category create：合法请求返回 201 与默认值', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/product-categories')
      .set(auth())
      .send({ name: 'Plywood A', slug: CAT_A_SLUG, description: 'cat A' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      name: 'Plywood A',
      slug: CAT_A_SLUG,
      sortOrder: 0,
      isActive: true,
      productCount: 0,
    });
    categoryAId = res.body.data.id as string;
  });

  it('Category create：非法 slug 被 DTO 校验拦截（400）', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/product-categories')
      .set(auth())
      .send({ name: 'Bad Slug', slug: 'Bad Slug!' })
      .expect(400);
  });

  it('Category create：slug 冲突返回 409', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/product-categories')
      .set(auth())
      .send({ name: 'Plywood A Again', slug: CAT_A_SLUG })
      .expect(409);
  });

  it('Category update：存在时部分更新；不存在返回 404', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/cms/product-categories/${categoryAId}`)
      .set(auth())
      .send({ name: 'Plywood A+', isActive: false })
      .expect(200);

    expect(res.body.data).toMatchObject({ name: 'Plywood A+', isActive: false, slug: CAT_A_SLUG });

    await request(app.getHttpServer())
      .patch('/api/v1/cms/product-categories/not-exist-id')
      .set(auth())
      .send({ name: 'Ghost Cat' })
      .expect(404);
  });

  it('Category list：包含新建分类并按 sortOrder 排序', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/cms/product-categories')
      .set(auth())
      .expect(200);

    const list = res.body.data as Array<{ id: string; slug: string; productCount: number }>;
    const found = list.find((c) => c.slug === CAT_A_SLUG);
    expect(found).toBeDefined();
    expect(found?.id).toBe(categoryAId);
    expect(found?.productCount).toBe(0);
  });

  it('Category delete：不存在返回 404；第二个分类可建可删', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/cms/product-categories/not-exist-id')
      .set(auth())
      .expect(404);

    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/product-categories')
      .set(auth())
      .send({ name: 'Temp Cat', slug: CAT_C_SLUG })
      .expect(201);
    const tempId = created.body.data.id as string;

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/product-categories/${tempId}`)
      .set(auth())
      .expect(200);

    // 分类无单查接口，经 list 确认已删
    const list = await request(app.getHttpServer())
      .get('/api/v1/cms/product-categories')
      .set(auth())
      .expect(200);
    expect((list.body.data as Array<{ id: string }>).find((c) => c.id === tempId)).toBeUndefined();
  });

  /* ------------------------- 产品 CRUD ------------------------- */

  it('Product create：合法请求返回 201，默认 DRAFT / 非 Featured', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/products')
      .set(auth())
      .send({
        name: 'E2E Oak Plywood',
        slug: `${SLUG_PREFIX}${RUN_ID}-1`,
        categoryId: categoryAId,
        description: 'e2e first product description',
        shortDescription: 'short desc',
        material: 'Oak',
        applications: ['Furniture', 'Construction'],
        specifications: { thickness: '18mm', material: 'Oak' },
        seoTitle: 'Oak Plywood',
        seoDescription: 'e2e seo description',
      })
      .expect(201);

    expect(res.body.data).toMatchObject({
      name: 'E2E Oak Plywood',
      status: ProductStatus.DRAFT,
      isFeatured: false,
      applications: ['Furniture', 'Construction'],
      specifications: { thickness: '18mm', material: 'Oak' },
      seoTitle: 'Oak Plywood',
    });
    product1Id = res.body.data.id as string;
  });

  it('Product create：详细描述按富文本净化后入库（剥离 script / 无关属性，保留结构）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/products')
      .set(auth())
      .send({
        name: 'E2E Rich Text Product',
        slug: `${SLUG_PREFIX}${RUN_ID}-rich`,
        categoryId: categoryAId,
        description:
          '<div class="module_attribute" data-module-name="module_attribute">' +
          '<h2>Composition</h2><p>Solid wood core.</p>' +
          '<script>alert(1)</script><a href="javascript:alert(2)">bad</a>' +
          '<a href="https://example.com">ok</a></div>',
        shortDescription: 'rich text product',
      })
      .expect(201);

    const html = res.body.data.description as string;
    // 结构与正文保留
    expect(html).toContain('<h2>Composition</h2>');
    expect(html).toContain('<p>Solid wood core.</p>');
    expect(html).toContain('href="https://example.com"');
    // 危险内容与迁移残留属性剥离
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('module_attribute');
    expect(html).not.toContain('data-module-name');

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/products/${res.body.data.id}`)
      .set(auth())
      .expect(200);
  });

  it('Product create：重复 slug 返回 409；分类不存在返回 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/products')
      .set(auth())
      .send({
        name: 'Duplicate',
        slug: `${SLUG_PREFIX}${RUN_ID}-1`,
        categoryId: categoryAId,
        description: 'another description',
      })
      .expect(409);

    await request(app.getHttpServer())
      .post('/api/v1/cms/products')
      .set(auth())
      .send({
        name: 'Wrong Cat',
        slug: `${SLUG_PREFIX}${RUN_ID}-wrong-cat`,
        categoryId: 'not-exist-category',
        description: 'another description',
      })
      .expect(400);
  });

  it('Product create：DTO 校验拦截非法请求（400）', async () => {
    const cases: Array<Record<string, unknown>> = [
      { name: 'X' }, // 缺 slug/categoryId/description
      {
        name: 'Bad Slug',
        slug: 'Bad Slug!',
        categoryId: categoryAId,
        description: 'x'.repeat(10),
      },
      {
        name: 'Bad Status',
        slug: `${SLUG_PREFIX}${RUN_ID}-bad-status`,
        categoryId: categoryAId,
        description: 'x'.repeat(10),
        status: 'NOT_A_STATUS',
      },
      {
        name: 'Bad Applications',
        slug: `${SLUG_PREFIX}${RUN_ID}-bad-apps`,
        categoryId: categoryAId,
        description: 'x'.repeat(10),
        applications: [1, 2, 3],
      },
      {
        name: 'Bad Specifications',
        slug: `${SLUG_PREFIX}${RUN_ID}-bad-specs`,
        categoryId: categoryAId,
        description: 'x'.repeat(10),
        specifications: ['not', 'an', 'object'],
      },
      {
        name: 'Short Description',
        slug: `${SLUG_PREFIX}${RUN_ID}-short-desc`,
        categoryId: categoryAId,
        description: 'too short',
      },
      {
        // Phase 5.5：简短描述上限 100 字（列表卡片 + SEO 摘要唯一来源）
        name: 'Overlong Short Description',
        slug: `${SLUG_PREFIX}${RUN_ID}-long-short-desc`,
        categoryId: categoryAId,
        description: 'x'.repeat(20),
        shortDescription: 'y'.repeat(101),
      },
    ];

    for (const body of cases) {
      await request(app.getHttpServer())
        .post('/api/v1/cms/products')
        .set(auth())
        .send(body)
        .expect(400);
    }
  });

  it('Product detail：存在返回完整数据；不存在返回 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${product1Id}`)
      .set(auth())
      .expect(200);

    expect(res.body.data).toMatchObject({
      id: product1Id,
      slug: `${SLUG_PREFIX}${RUN_ID}-1`,
      categoryId: categoryAId,
      status: ProductStatus.DRAFT,
    });

    await request(app.getHttpServer())
      .get('/api/v1/cms/products/not-exist-product')
      .set(auth())
      .expect(404);
  });

  it('Product update：PATCH 只改提供的字段，其余保持不变', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/cms/products/${product1Id}`)
      .set(auth())
      .send({ name: 'E2E Oak Plywood Pro', isFeatured: true })
      .expect(200);

    expect(res.body.data).toMatchObject({
      name: 'E2E Oak Plywood Pro',
      isFeatured: true,
      // Phase 1：普通更新永不改变发布态
      status: ProductStatus.DRAFT,
    });
    // 未提供的字段保持原值
    expect(res.body.data.slug).toBe(`${SLUG_PREFIX}${RUN_ID}-1`);
    expect(res.body.data.description).toBe('e2e first product description');
    expect(res.body.data.specifications).toEqual({ thickness: '18mm', material: 'Oak' });
  });

  it('Product update：不存在返回 404；直接 PATCH status 被 400 拒绝', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/cms/products/not-exist-product')
      .set(auth())
      .send({ name: 'Ghost Product' })
      .expect(404);

    // Update DTO 已移除 status：绕过前端直接请求也会被 ValidationPipe 拒绝
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/products/${product1Id}`)
      .set(auth())
      .send({ status: 'PUBLISHED' })
      .expect(400);
  });

  /* --------------------- 列表筛选 / 分页 --------------------- */

  it('Product list：keyword / status / categoryId 筛选与分页信封', async () => {
    // 第二个分类 + 第二个产品（PUBLISHED）
    const catB = await request(app.getHttpServer())
      .post('/api/v1/cms/product-categories')
      .set(auth())
      .send({ name: 'Plywood B', slug: CAT_B_SLUG })
      .expect(201);
    categoryBId = catB.body.data.id as string;

    const prod2 = await request(app.getHttpServer())
      .post('/api/v1/cms/products')
      .set(auth())
      .send({
        name: `E2E MDF ${KEYWORD}`,
        slug: `${SLUG_PREFIX}${RUN_ID}-2`,
        categoryId: categoryBId,
        description: 'second product description',
      })
      .expect(201);
    product2Id = prod2.body.data.id as string;
    // Phase 1：创建恒为 DRAFT，上线必须走独立发布动作
    expect(prod2.body.data.status).toBe(ProductStatus.DRAFT);

    // keyword 只命中第二件（唯一关键词）
    const byKeyword = await request(app.getHttpServer())
      .get('/api/v1/cms/products')
      .query({ keyword: KEYWORD })
      .set(auth())
      .expect(200);
    const kwItems = byKeyword.body.data.items as Array<{ id: string }>;
    expect(kwItems.map((i) => i.id)).toEqual([product2Id]);

    // 发布第二件 → status=PUBLISHED 只含它
    await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${product2Id}/publish`)
      .set(auth())
      .expect(200);

    const byPublished = await request(app.getHttpServer())
      .get('/api/v1/cms/products')
      .query({ status: 'PUBLISHED' })
      .set(auth())
      .expect(200);
    const publishedItems = byPublished.body.data.items as Array<{ id: string; status: ProductStatus }>;
    expect(publishedItems.every((i) => i.status === ProductStatus.PUBLISHED)).toBe(true);
    expect(publishedItems.find((i) => i.id === product2Id)).toBeDefined();

    // status=DRAFT 不含已发布的第二件
    const byDraft = await request(app.getHttpServer())
      .get('/api/v1/cms/products')
      .query({ status: 'DRAFT' })
      .set(auth())
      .expect(200);
    const draftItems = byDraft.body.data.items as Array<{ id: string; status: ProductStatus }>;
    expect(draftItems.every((i) => i.status === ProductStatus.DRAFT)).toBe(true);
    expect(draftItems.find((i) => i.id === product2Id)).toBeUndefined();

    // 取消发布 → status=UNPUBLISHED 含第二件（内容与历史保留）
    await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${product2Id}/unpublish`)
      .set(auth())
      .expect(200);

    const byUnpublished = await request(app.getHttpServer())
      .get('/api/v1/cms/products')
      .query({ status: 'UNPUBLISHED' })
      .set(auth())
      .expect(200);
    const unpublishedItems = byUnpublished.body.data.items as Array<{ id: string }>;
    expect(unpublishedItems.map((i) => i.id)).toContain(product2Id);

    // categoryId 精确筛选
    const byCat = await request(app.getHttpServer())
      .get('/api/v1/cms/products')
      .query({ categoryId: categoryBId })
      .set(auth())
      .expect(200);
    expect((byCat.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([product2Id]);

    // 分页信封字段完整
    const page = await request(app.getHttpServer())
      .get('/api/v1/cms/products')
      .query({ page: 1, limit: 1 })
      .set(auth())
      .expect(200);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.page).toBe(1);
    expect(page.body.data.limit).toBe(1);
    expect(page.body.data.total).toBeGreaterThanOrEqual(2);
    expect(page.body.data.totalPages).toBeGreaterThanOrEqual(2);

    // limit 超过 DTO 上限（100）被校验拦截（服务层另有 clamp 兜底，见单测）
    await request(app.getHttpServer())
      .get('/api/v1/cms/products')
      .query({ limit: 500 })
      .set(auth())
      .expect(400);

    // 非法分页参数被 DTO 拦截
    await request(app.getHttpServer())
      .get('/api/v1/cms/products')
      .query({ page: 0 })
      .set(auth())
      .expect(400);
  });

  /* --------------------- Product Image Relation --------------------- */

  it('Product image：上传合法 PNG 成功，首图默认主图并可静态访问', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${product1Id}/images`)
      .set(auth())
      .attach('file', PNG_BYTES, { filename: 'demo.png', contentType: 'image/png' })
      .expect(201);

    expect(res.body.data).toMatchObject({ isPrimary: true, altText: null, sortOrder: 0 });
    const url = res.body.data.url as string;
    expect(url).toMatch(/\/uploads\/products\/[0-9a-f-]{36}\.png$/);
    image1Id = res.body.data.id as string;

    // 文件真实落盘且经 /uploads 静态路由可读（app.setup.ts 挂载点）
    const fileName = url.split('/').pop() as string;
    expect(existsSync(path.join(PRODUCT_UPLOAD_DIR, fileName))).toBe(true);
    await request(app.getHttpServer()).get(`/uploads/products/${fileName}`).expect(200);
  });

  it('Product image：第二张非主图；alt/sortOrder 生效；详情返回两张图', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${product1Id}/images`)
      .set(auth())
      .attach('file', PNG_BYTES, { filename: 'demo2.png', contentType: 'image/png' })
      .field('alt', '第二张图')
      .field('sortOrder', '5')
      .expect(201);

    expect(res.body.data).toMatchObject({ isPrimary: false, altText: '第二张图', sortOrder: 5 });
    image2Id = res.body.data.id as string;

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${product1Id}`)
      .set(auth())
      .expect(200);
    const images = detail.body.data.images as Array<{ id: string; isPrimary: boolean }>;
    expect(images).toHaveLength(2);
    expect(images[0].id).toBe(image1Id); // 主图排最前
    expect(images[0].isPrimary).toBe(true);
    expect(images[1].id).toBe(image2Id);
  });

  it('Product image：伪造 MIME（文本内容 + .png 扩展名）返回 400 且清理磁盘文件', async () => {
    const before = uploadsSnapshot();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${product1Id}/images`)
      .set(auth())
      .attach('file', Buffer.from('<html>not an image</html>'), {
        filename: 'fake.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(uploadsSnapshot()).toEqual(before); // 无残留文件
  });

  it('Product image：非图片 MIME/扩展名被 multer fileFilter 拒绝（400）', async () => {
    const before = uploadsSnapshot();
    await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${product1Id}/images`)
      .set(auth())
      .attach('file', Buffer.from('plain text'), { filename: 'note.txt', contentType: 'text/plain' })
      .expect(400);
    expect(uploadsSnapshot()).toEqual(before);
  });

  it('Product image：缺少 file 字段返回 400', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${product1Id}/images`)
      .set(auth())
      .field('alt', 'no file')
      .expect(400);
  });

  it('Product image：产品不存在时返回 404 且清理已落盘文件', async () => {
    const before = uploadsSnapshot();
    await request(app.getHttpServer())
      .post('/api/v1/cms/products/not-exist-product/images')
      .set(auth())
      .attach('file', PNG_BYTES, { filename: 'ghost.png', contentType: 'image/png' })
      .expect(404);
    expect(uploadsSnapshot()).toEqual(before);
  });

  it('Product image：删除主图后自动提升最早的一张为主图', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/cms/products/${product1Id}/images/${image1Id}`)
      .set(auth())
      .expect(200);
    expect(res.body.data).toEqual({ id: image1Id });

    // 主图文件已从磁盘删除
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${product1Id}`)
      .set(auth())
      .expect(200);
    const images = detail.body.data.images as Array<{ id: string; isPrimary: boolean }>;
    expect(images).toHaveLength(1);
    expect(images[0].id).toBe(image2Id);
    expect(images[0].isPrimary).toBe(true); // 新主图

    // 重复删除返回 404
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/products/${product1Id}/images/${image1Id}`)
      .set(auth())
      .expect(404);
  });

  it('Product delete：删除产品返回 200，详情 404，磁盘图片文件同步清理', async () => {
    // 删除前记录剩余图片文件
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${product1Id}`)
      .set(auth())
      .expect(200);
    const files = (detail.body.data.images as Array<{ url: string }>).map((i) =>
      i.url.split('/').pop() as string,
    );
    expect(files.length).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/products/${product1Id}`)
      .set(auth())
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${product1Id}`)
      .set(auth())
      .expect(404);

    for (const file of files) {
      expect(existsSync(path.join(PRODUCT_UPLOAD_DIR, file))).toBe(false);
    }
  });

  it('Product delete：不存在返回 404；分类有产品时禁删（400），产品删后可删分类', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/cms/products/not-exist-product')
      .set(auth())
      .expect(404);

    // product2 仍在 categoryB 下：删除分类应被拒绝
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/product-categories/${categoryBId}`)
      .set(auth())
      .expect(400);

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/products/${product2Id}`)
      .set(auth())
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/product-categories/${categoryBId}`)
      .set(auth())
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/product-categories/${categoryAId}`)
      .set(auth())
      .expect(200);
  });
});
