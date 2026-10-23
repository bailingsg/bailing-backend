import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole, ContentStatus, ProductStatus, RoleStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';
import { UPLOAD_ROOT } from '../src/modules/cms/products/upload.options';

/**
 * Phase 1 发布工作流端到端测试。
 *
 * 覆盖任务书要求的核心不变量：
 *   1. 创建不接受 PUBLISHED（Create DTO 无 status）
 *   2. Update DTO 不接受 status —— 绕过前端直接请求也失败
 *   3. 保存 ≠ 发布：已发布实体的普通保存只写编辑稿，线上版本不动
 *   4. 发布是原子的：校验失败整体回滚，线上版本与历史都不变
 *   5. 取消发布：内容与历史保留，公开侧立即 404
 *   6. 编辑 / 发布 / 取消发布 三种权限严格分离
 *   7. 编辑稿乐观锁：版本不匹配 409
 *   8. 发布历史按版本号递增且唯一
 *   9. 删除实体时连带清理编辑稿与历史（无孤儿数据）
 *  10. 未登录一律 401
 */

const RUN_ID = Date.now().toString(36);
const SLUG_PREFIX = 'e2e-pub-';
const E2E_EMAIL = 'e2e-pub-admin@bailingwooden.test';
const EDITOR_EMAIL = 'e2e-pub-editor@bailingwooden.test';
const E2E_PASSWORD = 'E2E-pass-2026!';
const CAT_SLUG = `${SLUG_PREFIX}${RUN_ID}-cat`;
const PRODUCT_SLUG = `${SLUG_PREFIX}${RUN_ID}-p1`;
const EMPTY_SECTION_KEY = `e2e.empty.${RUN_ID}`;
const SECTION_KEY = `e2e.hero.${RUN_ID}`;
const EDITOR_ROLE_KEY = `E2E_PUB_EDITOR_${RUN_ID}`;

describe('Publishing workflow（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let editorToken: string;
  let adminId: string;
  let editorId: string;
  let roleId: string;
  let categoryId: string;
  let productId: string;
  let emptySectionId: string;
  let sectionId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const editorAuth = () => ({ Authorization: `Bearer ${editorToken}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();

    // 超级管理员（ADMIN 走 LEGACY 回落，拥有全部权限）
    const admin = await prisma.adminUser.create({
      data: {
        email: E2E_EMAIL,
        passwordHash: bcrypt.hashSync(E2E_PASSWORD, 4),
        name: 'E2E Publish Admin',
        role: AdminRole.ADMIN,
        isActive: true,
      },
    });
    adminId = admin.id;

    // 受限角色：可读可编辑，但**没有**发布/取消发布权限
    const role = await prisma.role.create({
      data: {
        key: EDITOR_ROLE_KEY,
        name: 'E2E 内容编辑（无发布权）',
        description: 'e2e 用：仅 products.read / products.update',
        status: RoleStatus.ACTIVE,
      },
    });
    roleId = role.id;
    const perms = await prisma.permission.findMany({
      where: { key: { in: ['dashboard.read', 'products.read', 'products.update'] } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
    });

    const editor = await prisma.adminUser.create({
      data: {
        email: EDITOR_EMAIL,
        passwordHash: bcrypt.hashSync(E2E_PASSWORD, 4),
        name: 'E2E Publish Editor',
        role: AdminRole.EDITOR,
        isActive: true,
      },
    });
    editorId = editor.id;
    await prisma.adminUserRole.create({ data: { adminUserId: editor.id, roleId: role.id } });

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: E2E_EMAIL, password: E2E_PASSWORD })
      .expect(200);
    token = adminLogin.body.data.accessToken as string;

    const editorLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EDITOR_EMAIL, password: E2E_PASSWORD })
      .expect(200);
    editorToken = editorLogin.body.data.accessToken as string;

    const category = await prisma.category.create({
      data: { name: 'E2E 发布测试分类', slug: CAT_SLUG },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await cleanup();
    if (editorId) await prisma.adminUser.deleteMany({ where: { id: editorId } });
    if (adminId) await prisma.adminUser.deleteMany({ where: { id: adminId } });
    if (roleId) await prisma.role.deleteMany({ where: { id: roleId } });
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const products = await prisma.product.findMany({
      where: { slug: { startsWith: SLUG_PREFIX } },
      select: { id: true, images: { select: { url: true } } },
    });
    const ids = products.map((p) => p.id);
    // Phase 6.0：图片落在 uploads/media/YYYY/MM/，删行前先按 URL 解析物理路径清理
    for (const product of products) {
      for (const image of product.images) {
        const rel = image.url.split('/uploads/')[1];
        if (rel) await rm(path.join(UPLOAD_ROOT, rel), { force: true });
      }
    }
    if (ids.length > 0) {
      await prisma.contentDraft.deleteMany({ where: { entityType: 'PRODUCT', entityId: { in: ids } } });
      await prisma.contentRevision.deleteMany({
        where: { entityType: 'PRODUCT', entityId: { in: ids } },
      });
      await prisma.product.deleteMany({ where: { id: { in: ids } } });
    }
    const sections = await prisma.siteSection.findMany({
      where: { sectionKey: { contains: RUN_ID } },
      select: { id: true },
    });
    const sectionIds = sections.map((s) => s.id);
    if (sectionIds.length > 0) {
      await prisma.contentDraft.deleteMany({
        where: { entityType: 'SITE_SECTION', entityId: { in: sectionIds } },
      });
      await prisma.contentRevision.deleteMany({
        where: { entityType: 'SITE_SECTION', entityId: { in: sectionIds } },
      });
      await prisma.siteSection.deleteMany({ where: { id: { in: sectionIds } } });
    }
    await prisma.category.deleteMany({ where: { slug: CAT_SLUG } });
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: { in: [adminId, editorId].filter(Boolean) } } });
  }

  /* ------------------------- 1. 创建不接受发布态 ------------------------- */

  it('创建产品：Create DTO 拒绝 status（400），不带 status 时恒为 DRAFT', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cms/products')
      .set(auth())
      .send({
        name: '越权发布',
        slug: `${SLUG_PREFIX}${RUN_ID}-illegal`,
        categoryId,
        description: '试图在创建时直接发布',
        status: 'PUBLISHED',
      })
      .expect(400);

    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/products')
      .set(auth())
      .send({
        name: 'E2E 发布测试产品',
        slug: PRODUCT_SLUG,
        categoryId,
        description: '发布工作流测试用产品',
        shortDescription: '短描述',
      })
      .expect(201);

    expect(created.body.data.status).toBe(ProductStatus.DRAFT);
    productId = created.body.data.id as string;

    // Phase 6.0：上架下限 4 张图（服务端强制 validate），发布前先补齐，
    // 否则后续所有发布用例都会倒在 400（与产品图数量规则无关的流程无法验证）
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('publishing-e2e-filler'),
    ]);
    for (let i = 0; i < 4; i += 1) {
      await request(app.getHttpServer())
        .post(`/api/v1/cms/products/${productId}/images`)
        .set(auth())
        .attach('file', PNG, { filename: `pub-${i}.png`, contentType: 'image/png' })
        .expect(201);
    }
  });

  it('更新产品：Update DTO 拒绝 status（直接请求 API 也失败）', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/products/${productId}`)
      .set(auth())
      .send({ status: 'PUBLISHED' })
      .expect(400);

    // 发布态未被改动
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${productId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.data.status).toBe(ProductStatus.DRAFT);
  });

  /* ------------------------- 2. 权限分离 ------------------------- */

  it('无 publish 权限的账号：可以保存草稿（200），不能发布（403）', async () => {
    // products.update 在手 → 允许编辑
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/products/${productId}`)
      .set(editorAuth())
      .send({ shortDescription: '编辑改的短描述' })
      .expect(200);

    // products.publish 未授予 → 拒绝
    await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${productId}/publish`)
      .set(editorAuth())
      .expect(403);

    // 取消发布同样需要独立权限
    await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${productId}/unpublish`)
      .set(editorAuth())
      .expect(403);
  });

  it('未登录访问发布/预览接口一律 401', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${productId}/publish`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${productId}/preview`)
      .expect(401);
  });

  /* ------------------------- 3. 首次发布 ------------------------- */

  it('首次发布：状态切 PUBLISHED、版本推进、写入历史、公开站可见', async () => {
    const before = await request(app.getHttpServer())
      .get(`/api/v1/products/${PRODUCT_SLUG}`)
      .expect(404);

    const published = await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${productId}/publish`)
      .set(auth())
      .expect(200);
    expect(published.body.data.status).toBe(ProductStatus.PUBLISHED);

    const publicDetail = await request(app.getHttpServer())
      .get(`/api/v1/products/${PRODUCT_SLUG}`)
      .expect(200);
    expect(publicDetail.body.data.slug).toBe(PRODUCT_SLUG);

    const list = await request(app.getHttpServer())
      .get('/api/v1/products?pageSize=48')
      .expect(200);
    const slugs = (list.body.data.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(slugs).toContain(PRODUCT_SLUG);

    const revisions = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${productId}/revisions`)
      .set(auth())
      .expect(200);
    expect(revisions.body.data).toHaveLength(1);
    expect(revisions.body.data[0]).toMatchObject({ version: 1, action: 'PUBLISH' });

    expect(before.status).toBe(404);
  });

  /* ------------------------- 4. 保存 ≠ 发布 ------------------------- */

  it('已发布后保存：只写编辑稿，线上版本与公开站内容不变', async () => {
    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/cms/products/${productId}`)
      .set(auth())
      .send({ name: '改名（未发布）', description: '改了描述但尚未发布的版本内容' })
      .expect(200);

    // 返回的是线上版本 + 未发布标记
    expect(patched.body.data.hasUnpublishedChanges).toBe(true);
    expect(patched.body.data.name).toBe('E2E 发布测试产品');
    expect(patched.body.data.draftVersion).toBe(1);

    // 公开站仍是旧内容
    const publicDetail = await request(app.getHttpServer())
      .get(`/api/v1/products/${PRODUCT_SLUG}`)
      .expect(200);
    expect(publicDetail.body.data.name).toBe('E2E 发布测试产品');

    // 预览可读到编辑稿
    const preview = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${productId}/preview`)
      .set(auth())
      .expect(200);
    expect(preview.body.data.hasUnpublishedChanges).toBe(true);
    expect(preview.body.data.draft).toMatchObject({ name: '改名（未发布）' });
  });

  it('编辑稿乐观锁：版本不匹配时 409，不静默覆盖', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/products/${productId}`)
      .set(auth())
      .set('X-Draft-Version', '1')
      .send({ name: '并发保存 A' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/v1/cms/products/${productId}`)
      .set(auth())
      .set('X-Draft-Version', '1')
      .send({ name: '并发保存 B' })
      .expect(409);
  });

  it('并发发布保护：目标版本号已被占用时 409，线上版本与历史不变', async () => {
    // 用独立产品，避免影响后续用例对版本号的断言
    const slug = `${SLUG_PREFIX}${RUN_ID}-cc`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/products')
      .set(auth())
      .send({
        name: '并发发布测试',
        slug,
        description: 'e2e 用：验证发布版本号冲突时的并发保护。',
        categoryId,
      })
      .expect(201);
    const id = created.body.data.id as string;

    // Phase 6.0：上架下限 4 张图，先通过完整性校验才能走到版本冲突分支
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('publishing-e2e-cc'),
    ]);
    for (let i = 0; i < 4; i += 1) {
      await request(app.getHttpServer())
        .post(`/api/v1/cms/products/${id}/images`)
        .set(auth())
        .attach('file', PNG, { filename: `cc-${i}.png`, contentType: 'image/png' })
        .expect(201);
    }

    // 模拟「他人抢先发布了 v1」：直接占用该版本号
    // （ContentRevision 的 @@unique([entityType, entityId, version]) 是并发兜底）
    await prisma.contentRevision.create({
      data: {
        entityType: 'PRODUCT',
        entityId: id,
        version: 1,
        action: 'PUBLISH',
        snapshot: { _e2e: true },
      },
    });

    const conflict = await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${id}/publish`)
      .set(auth())
      .expect(409);
    expect(JSON.stringify(conflict.body)).toContain('版本冲突');

    // 事务整体回滚：状态没变、线上版本没推进、历史没多出一条
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.data.status).toBe(ProductStatus.DRAFT);

    const revisions = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${id}/revisions`)
      .set(auth())
      .expect(200);
    expect(revisions.body.data).toHaveLength(1); // 只有手工占用版本号的那一条

    await prisma.contentRevision.deleteMany({ where: { entityType: 'PRODUCT', entityId: id } });
    await prisma.contentDraft.deleteMany({ where: { entityType: 'PRODUCT', entityId: id } });
    await prisma.product.delete({ where: { id } });
  });

  /* ------------------------- 5. 发布历史与版本 ------------------------- */

  it('再次发布：版本号递增、编辑稿清除、公开站更新', async () => {
    const published = await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${productId}/publish`)
      .set(auth())
      .expect(200);
    expect(published.body.data.status).toBe(ProductStatus.PUBLISHED);

    const publicDetail = await request(app.getHttpServer())
      .get(`/api/v1/products/${PRODUCT_SLUG}`)
      .expect(200);
    expect(publicDetail.body.data.name).toBe('并发保存 A');

    const revisions = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${productId}/revisions`)
      .set(auth())
      .expect(200);
    expect(revisions.body.data.map((r: { version: number }) => r.version)).toEqual([2, 1]);

    const preview = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${productId}/preview`)
      .set(auth())
      .expect(200);
    expect(preview.body.data.hasUnpublishedChanges).toBe(false);
    expect(preview.body.data.draft).toBeNull();
  });

  /* ------------------------- 6. 取消发布 ------------------------- */

  it('取消发布：公开侧立即 404，后台仍可读内容，历史保留', async () => {
    const unpublished = await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${productId}/unpublish`)
      .set(auth())
      .expect(200);
    expect(unpublished.body.data.status).toBe(ProductStatus.UNPUBLISHED);

    // 公开详情 404（不泄漏存在性）
    await request(app.getHttpServer()).get(`/api/v1/products/${PRODUCT_SLUG}`).expect(404);

    // 公开列表不再包含
    const list = await request(app.getHttpServer())
      .get('/api/v1/products?pageSize=48')
      .expect(200);
    const slugs = (list.body.data.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(slugs).not.toContain(PRODUCT_SLUG);

    // 后台内容与历史都还在
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${productId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.data.name).toBe('并发保存 A');

    const revisions = await request(app.getHttpServer())
      .get(`/api/v1/cms/products/${productId}/revisions`)
      .set(auth())
      .expect(200);
    expect(revisions.body.data).toHaveLength(2);

    // 重新发布即可恢复上线
    await request(app.getHttpServer())
      .post(`/api/v1/cms/products/${productId}/publish`)
      .set(auth())
      .expect(200);
    await request(app.getHttpServer()).get(`/api/v1/products/${PRODUCT_SLUG}`).expect(200);
  });

  /* ------------------------- 7. 服务端发布校验 ------------------------- */

  it('站点分区：空内容发布被服务端拒绝（400），状态与历史不变', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/site/sections')
      .set(auth())
      .send({ page: 'HOME', sectionKey: EMPTY_SECTION_KEY })
      .expect(201);
    emptySectionId = created.body.data.id as string;
    expect(created.body.data.status).toBe(ContentStatus.DRAFT);

    await request(app.getHttpServer())
      .post(`/api/v1/cms/site/sections/${emptySectionId}/publish`)
      .set(auth())
      .expect(400);

    // 发布失败：状态仍是 DRAFT，没有产生历史
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/site/sections/${emptySectionId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.data.status).toBe(ContentStatus.DRAFT);

    const revisions = await request(app.getHttpServer())
      .get(`/api/v1/cms/site/sections/${emptySectionId}/revisions`)
      .set(auth())
      .expect(200);
    expect(revisions.body.data).toHaveLength(0);
  });

  it('站点分区：有内容即可发布，公开接口按 page/sectionKey 可读', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/site/sections')
      .set(auth())
      .send({
        page: 'HOME',
        sectionKey: SECTION_KEY,
        eyebrow: 'E2E',
        title: '发布测试分区',
        body: '正文内容',
      })
      .expect(201);
    sectionId = created.body.data.id as string;

    // 未发布时公开接口 404
    await request(app.getHttpServer())
      .get(`/api/v1/public/site/HOME/${SECTION_KEY}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/v1/cms/site/sections/${sectionId}/publish`)
      .set(auth())
      .expect(200);

    const publicSection = await request(app.getHttpServer())
      .get(`/api/v1/public/site/HOME/${SECTION_KEY}`)
      .expect(200);
    expect(publicSection.body.data.title).toBe('发布测试分区');

    // 取消发布 → 公开 404，内容保留
    await request(app.getHttpServer())
      .post(`/api/v1/cms/site/sections/${sectionId}/unpublish`)
      .set(auth())
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/public/site/HOME/${SECTION_KEY}`)
      .expect(404);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/cms/site/sections/${sectionId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.data.title).toBe('发布测试分区');
    expect(detail.body.data.status).toBe(ContentStatus.UNPUBLISHED);
  });

  /* ------------------------- 8. 删除连带清理 ------------------------- */

  it('删除实体：编辑稿与发布历史一并清理，不留孤儿数据', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/cms/site/sections/${sectionId}`)
      .set(auth())
      .send({ title: '删除前的未发布修改' })
      .expect(200);

    const draftBefore = await prisma.contentDraft.count({
      where: { entityType: 'SITE_SECTION', entityId: sectionId },
    });
    expect(draftBefore).toBe(1);

    await request(app.getHttpServer())
      .delete(`/api/v1/cms/site/sections/${sectionId}`)
      .set(auth())
      .expect(200);

    expect(
      await prisma.contentDraft.count({ where: { entityType: 'SITE_SECTION', entityId: sectionId } }),
    ).toBe(0);
    expect(
      await prisma.contentRevision.count({
        where: { entityType: 'SITE_SECTION', entityId: sectionId },
      }),
    ).toBe(0);
  });
});
