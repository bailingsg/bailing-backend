import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole, MediaProvider, PostStatus } from '@prisma/client';
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
 * Blog CMS 端到端测试（Phase 4.4）。
 *
 * 依赖本地 Docker PostgreSQL（blog_posts / blog_categories / blog_tags / blog_post_tags
 * / media_assets 表已存在）。
 *
 * 覆盖任务书要求：
 *   · JWT Protection（13 个博客接口无令牌一律 401）
 *   · Blog CRUD / Category CRUD / Tag CRUD
 *   · SEO 字段保存（seoTitle / seoDescription / seoKeywords / canonicalUrl / OG / Twitter）
 *   · 富文本 XSS 过滤（script 被剔除后才入库）
 *   · Media 关联（封面经 Media Library 上传 + 引用检查阻止删除）
 *
 * 测试数据统一使用 e2e-blog- 前缀 slug，beforeAll/afterAll 负责清理（含磁盘媒体文件）。
 */

const E2E_EMAIL = 'e2e-blog@bailingwooden.test';
const E2E_PASSWORD = 'E2E-blog-2026!';
const SLUG_PREFIX = 'e2e-blog-';
const RUN_ID = Date.now().toString(36);
const CAT_SLUG = `${SLUG_PREFIX}${RUN_ID}-cat`;
const TAG_SLUG = `${SLUG_PREFIX}${RUN_ID}-tag`;
const POST_SLUG = `${SLUG_PREFIX}${RUN_ID}-post`;
const KEYWORD = `kwd-${RUN_ID}`;

/** 合法 PNG（签名 + IHDR，640×480）——媒体库魔数校验与尺寸解析都需要 */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]), // IHDR
  Buffer.from([0x00, 0x00, 0x02, 0x80]), // width 640
  Buffer.from([0x00, 0x00, 0x01, 0xe0]), // height 480
]);

describe('Blog CMS（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let categoryId: string;
  let tagId: string;
  let post1Id: string;
  let post2Id: string;
  let mediaId: string;
  let mediaUrl: string;
  let mediaStorageKey: string;

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
        name: 'E2E Blog Admin',
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

  /** 清理：先删文章（级联标签关联）→ 分类/标签 → 测试管理员上传的媒体（含磁盘文件） */
  async function cleanupTestData(): Promise<void> {
    await prisma.blogPost.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.blogCategory.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.blogTag.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });

    const assets = await prisma.mediaAsset.findMany({
      where: { originalName: { startsWith: 'e2e-blog-' } },
      select: { id: true, storageKey: true },
    });
    for (const asset of assets) {
      // storageKey 形如 media/<年>/<月>/<uuid>.<ext>；物理路径需剥离 media/ 命名空间前缀
      const relative = asset.storageKey.startsWith('media/')
        ? asset.storageKey.slice('media/'.length)
        : asset.storageKey;
      await rm(path.join(MEDIA_UPLOAD_ROOT, relative), { force: true });
    }
    await prisma.mediaAsset.deleteMany({ where: { originalName: { startsWith: 'e2e-blog-' } } });
  }

  /* ------------------------- JWT 保护矩阵 ------------------------- */

  it('JWT protect：全部博客 CMS 接口无令牌返回 401', async () => {
    const probes: Array<[string, string]> = [
      ['get', '/api/v1/cms/blog/posts'],
      ['post', '/api/v1/cms/blog/posts'],
      ['get', '/api/v1/cms/blog/posts/whatever'],
      ['patch', '/api/v1/cms/blog/posts/whatever'],
      ['delete', '/api/v1/cms/blog/posts/whatever'],
      ['get', '/api/v1/cms/blog/categories'],
      ['post', '/api/v1/cms/blog/categories'],
      ['patch', '/api/v1/cms/blog/categories/whatever'],
      ['delete', '/api/v1/cms/blog/categories/whatever'],
      ['get', '/api/v1/cms/blog/tags'],
      ['post', '/api/v1/cms/blog/tags'],
      ['patch', '/api/v1/cms/blog/tags/whatever'],
      ['delete', '/api/v1/cms/blog/tags/whatever'],
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
      .get('/api/v1/cms/blog/posts')
      .set('Authorization', 'Bearer forged.token.value')
      .expect(401);
  });

  /* ------------------------- 分类 CRUD ------------------------- */

  it('Category：创建（默认值）→ 非法 slug 400 → 重名 409 → 更新 → 列表', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/blog/categories')
      .set(auth())
      .send({ name: '行业资讯', slug: CAT_SLUG, description: '行业资讯分类' })
      .expect(201);

    expect(created.body.data).toMatchObject({
      name: '行业资讯',
      slug: CAT_SLUG,
      sortOrder: 0,
      isActive: true,
      postCount: 0,
    });
    categoryId = created.body.data.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/cms/blog/categories')
      .set(auth())
      .send({ name: 'Bad Slug', slug: 'Bad Slug!' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/cms/blog/categories')
      .set(auth())
      .send({ name: '重复', slug: CAT_SLUG })
      .expect(409);

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/cms/blog/categories/${categoryId}`)
      .set(auth())
      .send({ sortOrder: 5, isActive: true })
      .expect(200);
    expect(updated.body.data).toMatchObject({ sortOrder: 5, slug: CAT_SLUG });

    const list = await request(app.getHttpServer())
      .get('/api/v1/cms/blog/categories')
      .set(auth())
      .expect(200);
    const found = (list.body.data as Array<{ id: string; postCount: number }>).find(
      (c) => c.id === categoryId,
    );
    expect(found).toBeDefined();
  });

  /* ------------------------- 标签 CRUD ------------------------- */

  it('Tag：创建 → 非法 slug 400 → 重名 409 → 更新 → 列表含引用计数', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/blog/tags')
      .set(auth())
      .send({ name: '出口', slug: TAG_SLUG })
      .expect(201);
    expect(created.body.data).toMatchObject({ name: '出口', slug: TAG_SLUG, postCount: 0 });
    tagId = created.body.data.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/cms/blog/tags')
      .set(auth())
      .send({ name: 'Bad', slug: 'BAD SLUG' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/cms/blog/tags')
      .set(auth())
      .send({ name: '重复标签', slug: TAG_SLUG })
      .expect(409);

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/cms/blog/tags/${tagId}`)
      .set(auth())
      .send({ name: '出口贸易' })
      .expect(200);
    expect(updated.body.data).toMatchObject({ name: '出口贸易', slug: TAG_SLUG });

    const list = await request(app.getHttpServer())
      .get('/api/v1/cms/blog/tags')
      .set(auth())
      .expect(200);
    expect((list.body.data as Array<{ id: string }>).some((t) => t.id === tagId)).toBe(true);
  });

  /* ------------------------- 文章 CRUD + SEO ------------------------- */

  it('Post create：SEO/OG/Twitter 字段保存；正文 XSS 被过滤；默认 DRAFT', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cms/blog/posts')
      .set(auth())
      .send({
        title: `板材出口指南 ${KEYWORD}`,
        slug: POST_SLUG,
        excerpt: '出口指南摘要',
        content:
          '<h2>要点</h2><p>正文 <strong>加粗</strong></p><script>alert(1)</script><img src="x" onerror="alert(1)">',
        categoryId,
        tagIds: [tagId],
        seoTitle: '板材出口指南 | 百灵木业',
        seoDescription: '面向海外采购商的板材出口指南',
        seoKeywords: 'plywood,export,guide',
        canonicalUrl: 'https://bailingwooden.com/blog/plywood-export-guide',
        ogTitle: 'OG 标题',
        ogDescription: 'OG 描述',
        ogImage: 'https://bailingwooden.com/og.png',
        twitterTitle: 'Twitter 标题',
        twitterDescription: 'Twitter 描述',
      })
      .expect(201);

    const data = res.body.data as Record<string, unknown>;
    post1Id = data.id as string;

    expect(data).toMatchObject({
      title: `板材出口指南 ${KEYWORD}`,
      slug: POST_SLUG,
      status: PostStatus.DRAFT,
      featured: false,
      categoryId,
      tagIds: [tagId],
      seoTitle: '板材出口指南 | 百灵木业',
      seoDescription: '面向海外采购商的板材出口指南',
      seoKeywords: 'plywood,export,guide',
      canonicalUrl: 'https://bailingwooden.com/blog/plywood-export-guide',
      ogTitle: 'OG 标题',
      ogDescription: 'OG 描述',
      ogImage: 'https://bailingwooden.com/og.png',
      twitterTitle: 'Twitter 标题',
      twitterDescription: 'Twitter 描述',
    });
    expect(data.publishedAt).toBeNull();

    // XSS 过滤：script 连同内容被剔除、onerror 被移除
    const content = data.content as string;
    expect(content).toContain('<h2>要点</h2>');
    expect(content).toContain('<strong>加粗</strong>');
    expect(content).not.toContain('<script');
    expect(content).not.toContain('onerror');
    expect(content).toBe('<h2>要点</h2><p>正文 <strong>加粗</strong></p><img src="x">');
  });

  it('Post create：重复 slug 409；分类/标签不存在 400；DTO 校验 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/blog/posts')
      .set(auth())
      .send({ title: '重复', slug: POST_SLUG, content: '<p>x</p>' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/api/v1/cms/blog/posts')
      .set(auth())
      .send({ title: '坏分类', slug: `${SLUG_PREFIX}${RUN_ID}-badcat`, content: '<p>x</p>', categoryId: 'nope' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/cms/blog/posts')
      .set(auth())
      .send({ title: '坏标签', slug: `${SLUG_PREFIX}${RUN_ID}-badtag`, content: '<p>x</p>', tagIds: ['nope'] })
      .expect(400);

    const cases: Array<Record<string, unknown>> = [
      { slug: `${SLUG_PREFIX}${RUN_ID}-nocontent` }, // 缺 title / content
      { title: 'X', slug: `${SLUG_PREFIX}${RUN_ID}-short`, content: '<p>x</p>' }, // title 太短
      { title: '坏 slug', slug: 'Bad Slug!', content: '<p>x</p>' }, // slug 非法
      { title: '坏状态', slug: `${SLUG_PREFIX}${RUN_ID}-badstatus`, content: '<p>x</p>', status: 'NOPE' },
      {
        title: '坏标签数组',
        slug: `${SLUG_PREFIX}${RUN_ID}-badtags`,
        content: '<p>x</p>',
        tagIds: [1, 2],
      },
      {
        title: '坏发布时间',
        slug: `${SLUG_PREFIX}${RUN_ID}-baddate`,
        content: '<p>x</p>',
        publishedAt: 'not-a-date',
      },
    ];
    for (const body of cases) {
      await request(app.getHttpServer()).post('/api/v1/cms/blog/posts').set(auth()).send(body).expect(400);
    }
  });

  it('Post detail：存在返回完整数据（含 category / tags / author）；不存在 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/cms/blog/posts/${post1Id}`)
      .set(auth())
      .expect(200);

    expect(res.body.data).toMatchObject({
      id: post1Id,
      category: { id: categoryId },
      author: { id: adminId, name: 'E2E Blog Admin' },
    });
    expect((res.body.data.tags as Array<{ id: string }>).map((t) => t.id)).toEqual([tagId]);

    await request(app.getHttpServer())
      .get('/api/v1/cms/blog/posts/not-exist-post')
      .set(auth())
      .expect(404);
  });

  it('Post update：PATCH 只改提供字段；转 PUBLISHED 自动补 publishedAt；SEO 可清空', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/cms/blog/posts/${post1Id}`)
      .set(auth())
      .send({ featured: true, status: 'PUBLISHED', seoDescription: null })
      .expect(200);

    expect(res.body.data).toMatchObject({
      featured: true,
      status: PostStatus.PUBLISHED,
      seoDescription: null,
      slug: POST_SLUG, // 未提供的字段不变
      seoTitle: '板材出口指南 | 百灵木业',
    });
    expect(typeof res.body.data.publishedAt).toBe('string');

    await request(app.getHttpServer())
      .patch('/api/v1/cms/blog/posts/not-exist-post')
      .set(auth())
      .send({ title: '幽灵' })
      .expect(404);
  });

  it('Post list：keyword / status / categoryId / featured 筛选与分页信封', async () => {
    // 第二篇（草稿、无分类）
    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/blog/posts')
      .set(auth())
      .send({
        title: `第二篇 ${KEYWORD}`,
        slug: `${SLUG_PREFIX}${RUN_ID}-post-2`,
        content: '<p>第二篇正文</p>',
        excerpt: '第二篇摘要',
      })
      .expect(201);
    post2Id = created.body.data.id as string;

    const byKeyword = await request(app.getHttpServer())
      .get('/api/v1/cms/blog/posts')
      .query({ keyword: KEYWORD })
      .set(auth())
      .expect(200);
    expect((byKeyword.body.data.items as Array<{ id: string }>).map((i) => i.id).sort()).toEqual(
      [post1Id, post2Id].sort(),
    );

    const byStatus = await request(app.getHttpServer())
      .get('/api/v1/cms/blog/posts')
      .query({ status: 'PUBLISHED' })
      .set(auth())
      .expect(200);
    const published = byStatus.body.data.items as Array<{ id: string; status: PostStatus }>;
    expect(published.every((i) => i.status === PostStatus.PUBLISHED)).toBe(true);
    expect(published.some((i) => i.id === post1Id)).toBe(true);

    const byCat = await request(app.getHttpServer())
      .get('/api/v1/cms/blog/posts')
      .query({ categoryId })
      .set(auth())
      .expect(200);
    expect((byCat.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([post1Id]);

    const byTag = await request(app.getHttpServer())
      .get('/api/v1/cms/blog/posts')
      .query({ tagId })
      .set(auth())
      .expect(200);
    expect((byTag.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([post1Id]);

    const page = await request(app.getHttpServer())
      .get('/api/v1/cms/blog/posts')
      .query({ page: 1, limit: 1 })
      .set(auth())
      .expect(200);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data).toMatchObject({ page: 1, limit: 1 });
    expect(page.body.data.total).toBeGreaterThanOrEqual(2);

    // limit 超上限 / page 非法 → DTO 拦截
    await request(app.getHttpServer()).get('/api/v1/cms/blog/posts').query({ limit: 500 }).set(auth()).expect(400);
    await request(app.getHttpServer()).get('/api/v1/cms/blog/posts').query({ page: 0 }).set(auth()).expect(400);
  });

  /* --------------------- Media 关联（封面） --------------------- */

  it('Media 关联：封面经媒体库上传 → coverMediaId 关联并回填 coverImageUrl 快照', async () => {
    const uploaded = await request(app.getHttpServer())
      .post('/api/v1/cms/media/upload')
      .set(auth())
      .attach('file', PNG_BYTES, { filename: 'e2e-blog-cover.png', contentType: 'image/png' })
      .expect(201);

    expect(uploaded.body.data).toMatchObject({ provider: MediaProvider.LOCAL, width: 640, height: 480 });
    mediaId = uploaded.body.data.id as string;
    mediaUrl = uploaded.body.data.url as string;
    mediaStorageKey = uploaded.body.data.storageKey as string;

    // 文件真实落盘（storageKey 剥离 media/ 前缀后拼接物理根目录）
    const relative = mediaStorageKey.startsWith('media/') ? mediaStorageKey.slice(6) : mediaStorageKey;
    expect(existsSync(path.join(MEDIA_UPLOAD_ROOT, relative))).toBe(true);

    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/cms/blog/posts/${post1Id}`)
      .set(auth())
      .send({ coverMediaId: mediaId })
      .expect(200);

    expect(patched.body.data).toMatchObject({ coverMediaId: mediaId, coverImageUrl: mediaUrl });
    expect(patched.body.data.coverMedia).toMatchObject({ id: mediaId, url: mediaUrl });
  });

  it('Media 关联：封面不存在的媒体 ID → 400', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/blog/posts/${post2Id}`)
      .set(auth())
      .send({ coverMediaId: 'not-exist-media' })
      .expect(400);
  });

  it('引用检查：被博客封面引用的媒体不可删除（400 "Media asset is in use."）', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/cms/media/${mediaId}`)
      .set(auth())
      .expect(400);
    expect(res.body.error.message).toBe('Media asset is in use.');

    // 解除封面关联后即可删除
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/blog/posts/${post1Id}`)
      .set(auth())
      .send({ coverMediaId: null })
      .expect(200);

    const detached = await request(app.getHttpServer())
      .get(`/api/v1/cms/blog/posts/${post1Id}`)
      .set(auth())
      .expect(200);
    expect(detached.body.data.coverMediaId).toBeNull();
    expect(detached.body.data.coverImageUrl).toBeNull();

    await request(app.getHttpServer()).delete(`/api/v1/cms/media/${mediaId}`).set(auth()).expect(200);

    const relative = mediaStorageKey.startsWith('media/') ? mediaStorageKey.slice(6) : mediaStorageKey;
    expect(existsSync(path.join(MEDIA_UPLOAD_ROOT, relative))).toBe(false);
  });

  /* ------------------------- 删除与级联 ------------------------- */

  it('Tag delete：删除标签后文章仍存在，仅解除关联', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/cms/blog/tags/${tagId}`).set(auth()).expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/blog/posts/${post1Id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.data.tags).toEqual([]);
    expect(detail.body.data.tagIds).toEqual([]);

    // 重复删除 404
    await request(app.getHttpServer()).delete(`/api/v1/cms/blog/tags/${tagId}`).set(auth()).expect(404);
  });

  it('Category delete：有文章时 400；文章清空后可删', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/blog/categories/${categoryId}`)
      .set(auth())
      .expect(400);

    await request(app.getHttpServer()).delete(`/api/v1/cms/blog/posts/${post1Id}`).set(auth()).expect(200);
    await request(app.getHttpServer()).delete(`/api/v1/cms/blog/posts/${post2Id}`).set(auth()).expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/cms/blog/posts/${post1Id}`)
      .set(auth())
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/blog/categories/${categoryId}`)
      .set(auth())
      .expect(200);

    // 重复删除 404
    await request(app.getHttpServer())
      .delete(`/api/v1/cms/blog/categories/${categoryId}`)
      .set(auth())
      .expect(404);
  });

  it('Post delete：不存在返回 404', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/cms/blog/posts/not-exist-post')
      .set(auth())
      .expect(404);
  });
});
