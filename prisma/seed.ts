import { PrismaClient, ProductStatus } from '@prisma/client';

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
 */

const prisma = new PrismaClient();

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

  const [categories, products] = await Promise.all([
    prisma.category.count(),
    prisma.product.count(),
  ]);

  console.log(`[seed] categories: ${categories}, products: ${products} (demo/placeholder only)`);
}

main()
  .catch((error) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
