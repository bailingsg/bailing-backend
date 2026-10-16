import 'dotenv/config';
import { AdminRole, PrismaClient, ProductStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { migrateLegacyRoles, seedBuiltinRoles, seedPermissions } from './seed-rbac';

/**
 * Phase 3.5 —— Demo / Placeholder 数据种子
 *
 * ⚠️ 重要说明
 * 这些**不是真实产品**：名称统一以 "Demo ·" 开头，描述明确标注 [DEMO DATA]，
 * 且**不含**任何编造的规格参数、认证、价格、客户案例或图片素材。
 *
 * 用途：在 CMS 上线前验证「产品列表页 / 产品详情页」模板与数据管道。
 * CMS 阶段可直接删除本脚本及其产生的数据，不影响其它模块。
 *
 * 幂等：按 slug upsert，可重复执行。
 * 运行：npm run prisma:seed
 *
 * Phase 4.1 —— 默认管理员初始化（见 seedDefaultAdmin）：
 * 从环境变量 ADMIN_EMAIL / ADMIN_PASSWORD 读取，禁止硬编码口令。
 */

const prisma = new PrismaClient();

/**
 * 初始化默认管理员。
 *
 * 规则：
 *   · 仅从环境变量 ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME 读取，缺失则跳过
 *   · 口令以 bcrypt 哈希入库（passwordHash），禁止明文
 *   · 幂等：账号存在时仅同步 name / isActive；
 *     若 ADMIN_PASSWORD 与现有哈希不匹配则同步更新口令（支持轮换）
 *   · 默认角色 ADMIN（系统中第一个账号）；如需 EDITOR 请在创建后于库中调整
 */
async function seedDefaultAdmin(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? '';
  const name = process.env.ADMIN_NAME ?? 'Administrator';

  if (email === '' || password === '') {
    console.log('[seed] ADMIN_EMAIL / ADMIN_PASSWORD 未配置，跳过默认管理员创建');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await prisma.adminUser.findUnique({ where: { email } });

  if (!existing) {
    await prisma.adminUser.create({
      data: { email, passwordHash, name, role: AdminRole.ADMIN, isActive: true },
    });
    console.log(`[seed] 已创建默认管理员: ${email} (ADMIN)`);
    return;
  }

  const passwordMatches = await bcrypt.compare(password, existing.passwordHash);
  await prisma.adminUser.update({
    where: { email },
    data: {
      name,
      isActive: true,
      // 口令仅在环境变量与库中哈希不一致时更新（支持轮换，且不反复重哈希）
      ...(passwordMatches ? {} : { passwordHash }),
    },
  });
  console.log(
    `[seed] 默认管理员已同步: ${email}${passwordMatches ? '' : '（口令已按 ADMIN_PASSWORD 更新）'}`,
  );
}

/** 分类体系（沿用产品线规划，非编造数据；CMS 阶段可自由调整） */
const DEMO_CATEGORIES = [
  {
    slug: 'wood-products',
    name: 'Wood Products',
    description: 'Solid wood panels and wooden components.',
    sortOrder: 10,
  },
  {
    slug: 'packaging-products',
    name: 'Packaging Products',
    description: 'Wooden packaging, crating and pallets.',
    sortOrder: 20,
  },
  {
    slug: 'industrial-products',
    name: 'Industrial Products',
    description: 'Wood-based industrial materials.',
    sortOrder: 30,
  },
  {
    slug: 'custom-solutions',
    name: 'Custom Solutions',
    description: 'OEM / ODM custom wooden products.',
    sortOrder: 40,
  },
];

/** 占位产品（仅用于模板验证，无真实规格 / 图片） */
const DEMO_PRODUCTS = [
  {
    slug: 'demo-wood-panel',
    name: 'Demo · Wood Panel',
    shortDescription: 'Placeholder entry used to validate the product template.',
    description:
      '[DEMO DATA] This is a placeholder product record. It exists only to verify the product listing and detail templates. It will be replaced by CMS-managed content and does not describe a real product.',
    categorySlug: 'wood-products',
    isFeatured: true,
  },
  {
    slug: 'demo-wooden-crate',
    name: 'Demo · Wooden Crate',
    shortDescription: 'Placeholder entry used to validate the product template.',
    description:
      '[DEMO DATA] This is a placeholder product record. It exists only to verify the product listing and detail templates. It will be replaced by CMS-managed content and does not describe a real product.',
    categorySlug: 'packaging-products',
    isFeatured: false,
  },
  {
    slug: 'demo-custom-component',
    name: 'Demo · Custom Wooden Component',
    shortDescription: 'Placeholder entry used to validate the product template.',
    description:
      '[DEMO DATA] This is a placeholder product record. It exists only to verify the product listing and detail templates. It will be replaced by CMS-managed content and does not describe a real product.',
    categorySlug: 'custom-solutions',
    isFeatured: false,
  },
];

async function main(): Promise<void> {
  await seedDefaultAdmin();

  // Phase 4.6：RBAC 权限清单 + 内置角色 + 历史角色迁移
  // 顺序要求：先同步权限（角色绑定需要 permissionId），再建角色，最后迁移账号关联
  const permissionIdByKey = await seedPermissions(prisma);
  const roleIdByKey = await seedBuiltinRoles(prisma, permissionIdByKey);
  await migrateLegacyRoles(prisma, roleIdByKey);

  const categoryIdBySlug = new Map<string, string>();

  for (const category of DEMO_CATEGORIES) {
    const record = await prisma.category.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: true,
      },
      create: { ...category, isActive: true },
    });
    categoryIdBySlug.set(record.slug, record.id);
  }

  for (const product of DEMO_PRODUCTS) {
    const categoryId = categoryIdBySlug.get(product.categorySlug);
    if (!categoryId) continue;

    await prisma.product.upsert({
      where: { slug: product.slug },
      update: {
        name: product.name,
        shortDescription: product.shortDescription,
        description: product.description,
        categoryId,
        isFeatured: product.isFeatured,
        status: ProductStatus.PUBLISHED,
      },
      create: {
        slug: product.slug,
        name: product.name,
        shortDescription: product.shortDescription,
        description: product.description,
        categoryId,
        isFeatured: product.isFeatured,
        status: ProductStatus.PUBLISHED,
        // material / application / specifications / images 一律留空：
        // 不编造产品规格与图片素材
      },
    });
  }

  const [categories, products, admins, permissions, roles] = await Promise.all([
    prisma.category.count(),
    prisma.product.count(),
    prisma.adminUser.count(),
    prisma.permission.count(),
    prisma.role.count(),
  ]);

  console.log(
    `[seed] categories: ${categories}, products: ${products} (demo/placeholder only), admins: ${admins}, permissions: ${permissions}, roles: ${roles}`,
  );
}

main()
  .catch((error) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
