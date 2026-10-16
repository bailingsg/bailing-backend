import { PrismaClient, ContentStatus, SitePage, NavLocation } from '@prisma/client';

/**
 * 站点内容种子（Phase 4.7）。
 *
 * 目的：把前台**既有真实文案**（首页 / 关于我们 / 导航 / 页脚）迁移进 CMS，
 * 使「后台改内容 → 前台公开 API → 页面」链路成立。
 *
 * 数据诚信（硬约束）：
 *   · 全部文案逐字迁移自 bailing-ui 既有页面（page.tsx / about/page.tsx /
 *     config/site.ts），**没有任何虚构内容**；
 *   · 未确认的联系方式、证书等**不写入**（保持 null，前台照常显示待补充）。
 *
 * 幂等性：
 *   · 分区按 (page, sectionKey) 复合唯一 upsert——已有内容只更新字段，不重复创建；
 *   · 导航 / 页脚项按创建者标记清理后重建（createdBy = 'seed:site-content'），
 *     不影响管理员后续手工新增的项。
 */

const SEED_ACTOR = 'seed:site-content';

/* ------------------------------ 首页分区 ------------------------------ */

const HOME_SECTIONS: {
  sectionKey: string;
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  body?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  items?: { title: string; description: string }[];
}[] = [
  {
    sectionKey: 'home.hero',
    eyebrow: 'B2B Wooden Products Manufacturer',
    title: 'Bailing Wooden',
    subtitle: '百灵木业 · 专业木制品制造 · B2B 出口工厂',
    body: 'Bailing Wooden is a professional wooden products manufacturer and B2B export supplier, serving global buyers with reliable quality, industrial craftsmanship and sustainable sourcing.',
    ctaLabel: 'Request Quote',
    ctaUrl: '/contact#rfq',
  },
  {
    sectionKey: 'home.capabilities',
    eyebrow: 'Capabilities',
    title: 'What we do',
    body: 'A complete manufacturing and export workflow, from custom production to documentation and shipment.',
    items: [
      {
        title: 'OEM & ODM',
        description:
          'Custom wooden products manufactured to your drawings, samples and specifications.',
      },
      {
        title: 'Quality Control',
        description:
          'Incoming material inspection, in-process checks and pre-shipment inspection before loading.',
      },
      {
        title: 'Export Logistics',
        description:
          'FOB / CIF terms with full export documentation support for international shipping.',
      },
      {
        title: 'Sustainable Sourcing',
        description: 'Responsibly sourced timber supported by traceability documentation.',
      },
    ],
  },
  {
    sectionKey: 'home.products',
    eyebrow: 'Products',
    title: 'Product categories',
    body: 'Product categories and specifications are published from the product catalog.',
    ctaLabel: 'View Products',
    ctaUrl: '/products',
  },
  {
    sectionKey: 'home.applications',
    eyebrow: 'Applications',
    title: 'Where our products are used',
    body: 'Typical application areas served by wooden product manufacturers. Detailed case studies are pending confirmation.',
    items: [
      {
        title: 'Furniture Manufacturing',
        description: 'Components and panels supplied to furniture producers.',
      },
      {
        title: 'Building & Construction',
        description: 'Wood-based materials for interior and structural applications.',
      },
      {
        title: 'Packaging & Logistics',
        description: 'Wooden packaging solutions for industrial shipping.',
      },
      {
        title: 'DIY & Home Improvement',
        description: 'Retail-ready wooden products for consumer markets.',
      },
    ],
  },
  {
    sectionKey: 'home.cta',
    title: 'Ready to source wooden products?',
    body: 'Send us your specification or drawing — our team will review it and respond with a quotation.',
    ctaLabel: 'Request Quote',
    ctaUrl: '/contact#rfq',
  },
];

/* ------------------------------ 关于我们分区 ------------------------------ */

const ABOUT_SECTIONS: {
  sectionKey: string;
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  body?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  items?: { title: string; description: string; href?: string }[];
}[] = [
  {
    sectionKey: 'about.hero',
    eyebrow: 'About',
    title: 'About Bailing Wooden',
    subtitle: '关于百灵木业',
    body: 'Reliable Wood Solutions for Global Partners — a wood panel manufacturer and export supplier working with furniture makers, importers and distributors.',
    ctaLabel: 'Request Quote',
    ctaUrl: '/contact#rfq',
  },
  {
    sectionKey: 'about.profile',
    eyebrow: 'Company Profile',
    title: 'A wood panel manufacturer built around process',
    body: 'Bailing Wooden (百灵木业) manufactures and exports wood-based panels from Shouguang, Shandong, China. Our product range covers MDF, plywood, particle board and decorative panels, supplied to furniture manufacturers, interior contractors, distributors and importers. We handle product development, production control and export supply as one continuous process — from confirming the specification to loading the container.',
  },
  {
    sectionKey: 'about.story',
    eyebrow: 'Our Story',
    title: 'From panel production to export supply',
    body: 'Bailing Wooden started in panel manufacturing — pressing, sanding and finishing boards for domestic furniture producers. As buyers from overseas began asking for the same products to their own specifications, the business grew into a direct export supplier with its own quality and documentation process. Instead of pushing a fixed catalogue, we start from the application: what the board has to do, how it will be machined, what surface it needs, and where it is going.',
  },
  {
    sectionKey: 'about.philosophy',
    eyebrow: 'Philosophy',
    title: 'How we approach the work',
    items: [
      {
        title: 'Consistent Quality',
        description:
          'Every order is produced against an agreed specification, so the boards you receive match the samples you approved.',
      },
      {
        title: 'Practical Craftsmanship',
        description:
          'Panels are judged by how they perform on the production line — machining, edge quality, surface finish and stability.',
      },
      {
        title: 'Responsible Sourcing',
        description:
          'Raw materials are sourced with traceability in mind, and offcuts are recovered back into production wherever possible.',
      },
      {
        title: 'Long-term Partnership',
        description:
          'We work as a supply partner rather than a one-off seller: clear communication before the order and support after it ships.',
      },
    ],
  },
  {
    sectionKey: 'about.why',
    eyebrow: 'Why Bailing',
    title: 'What you get when you work with us',
    items: [
      {
        title: 'Material know-how',
        description:
          'MDF, plywood, particle board and decorative panels each behave differently. We help you match the board to the application.',
      },
      {
        title: 'Specification clarity',
        description:
          'Thickness, density, glue type, surface treatment and tolerances are confirmed in writing before production starts.',
      },
      {
        title: 'Production control',
        description:
          'Incoming material, in-process panels and finished boards are checked at defined stages of the production flow.',
      },
      {
        title: 'Export documentation',
        description:
          'Commercial invoice, packing list and the shipping documents your forwarder needs are prepared as part of the order.',
      },
      {
        title: 'OEM & custom sizes',
        description:
          'Custom dimensions, cut-to-size panels and private-label surface finishes can be produced against your drawing.',
      },
      {
        title: 'Responsive communication',
        description:
          'Enquiries are reviewed by a person, not a queue — you get a straight answer on what is feasible and what is not.',
      },
    ],
  },
  {
    sectionKey: 'about.solutions',
    eyebrow: 'Products & Solutions',
    title: 'What we manufacture',
    items: [
      {
        title: 'MDF & HMR MDF',
        description: 'Standard, moisture-resistant and special-surface fibreboard for furniture and interiors.',
        href: '/products',
      },
      {
        title: 'Plywood',
        description: 'Commercial, film-faced and structural plywood for furniture, formwork and transport.',
        href: '/products',
      },
      {
        title: 'Particle Board',
        description: 'Raw and melamine-faced particle board for cabinets, shelving and flat-pack furniture.',
        href: '/products',
      },
      {
        title: 'Decorative Panels',
        description: 'Melamine, veneer, PET, UV and WPC surfaces for visible, design-facing applications.',
        href: '/products',
      },
      {
        title: 'Furniture Solutions',
        description: 'Door skins, edge banding, block board and cut-to-size components for furniture makers.',
        href: '/products',
      },
    ],
  },
];

/* ------------------------------ 导航 / 页脚 ------------------------------ */

const NAV_ITEMS: { location: NavLocation; label: string; url: string; sortOrder: number }[] = [
  // 页眉主导航（顺序即展示顺序）
  { location: NavLocation.HEADER, label: 'Home', url: '/', sortOrder: 10 },
  { location: NavLocation.HEADER, label: 'Products', url: '/products', sortOrder: 20 },
  { location: NavLocation.HEADER, label: 'Factory', url: '/factory', sortOrder: 30 },
  { location: NavLocation.HEADER, label: 'Quality', url: '/quality', sortOrder: 40 },
  { location: NavLocation.HEADER, label: 'Applications', url: '/applications', sortOrder: 50 },
  { location: NavLocation.HEADER, label: 'About', url: '/about', sortOrder: 60 },
  { location: NavLocation.HEADER, label: 'Blog', url: '/blog', sortOrder: 70 },
  { location: NavLocation.HEADER, label: 'Contact', url: '/contact', sortOrder: 80 },
  // 页脚链接组（Company）
  { location: NavLocation.FOOTER, label: 'About Us', url: '/about', sortOrder: 10 },
  { location: NavLocation.FOOTER, label: 'Factory', url: '/factory', sortOrder: 20 },
  { location: NavLocation.FOOTER, label: 'Quality Control', url: '/quality', sortOrder: 30 },
  { location: NavLocation.FOOTER, label: 'Insights & Guides', url: '/blog', sortOrder: 40 },
  // 页脚链接组（Products）
  { location: NavLocation.FOOTER, label: 'All Products', url: '/products', sortOrder: 50 },
  { location: NavLocation.FOOTER, label: 'Applications', url: '/applications', sortOrder: 60 },
  { location: NavLocation.FOOTER, label: 'Request Quote', url: '/contact#rfq', sortOrder: 70 },
  // 页脚链接组（Resources）
  { location: NavLocation.FOOTER, label: 'Certificates', url: '/quality#certificates', sortOrder: 80 },
  { location: NavLocation.FOOTER, label: 'FAQ', url: '/contact#faq', sortOrder: 90 },
  { location: NavLocation.FOOTER, label: 'Shipping & Terms', url: '/contact', sortOrder: 100 },
];

export async function seedSiteContent(prisma: PrismaClient): Promise<void> {
  for (const [page, sections] of [
    [SitePage.HOME, HOME_SECTIONS],
    [SitePage.ABOUT, ABOUT_SECTIONS],
  ] as const) {
    for (const section of sections) {
      await prisma.siteSection.upsert({
        where: { page_sectionKey: { page, sectionKey: section.sectionKey } },
        update: {
          eyebrow: section.eyebrow ?? null,
          title: section.title ?? null,
          subtitle: section.subtitle ?? null,
          body: section.body ?? null,
          ctaLabel: section.ctaLabel ?? null,
          ctaUrl: section.ctaUrl ?? null,
          items: section.items ? (section.items as unknown as object) : undefined,
          status: ContentStatus.PUBLISHED,
          sortOrder: (sections.indexOf(section) + 1) * 10,
          publishedAt: new Date(),
          createdBy: SEED_ACTOR,
        },
        create: {
          page,
          sectionKey: section.sectionKey,
          eyebrow: section.eyebrow ?? null,
          title: section.title ?? null,
          subtitle: section.subtitle ?? null,
          body: section.body ?? null,
          ctaLabel: section.ctaLabel ?? null,
          ctaUrl: section.ctaUrl ?? null,
          items: section.items ? (section.items as unknown as object) : undefined,
          status: ContentStatus.PUBLISHED,
          sortOrder: (sections.indexOf(section) + 1) * 10,
          createdBy: SEED_ACTOR,
          publishedAt: new Date(),
        },
      });
    }
    console.log(`[seed:site-content] ${page} 分区已同步: ${sections.length} 个`);
  }

  // 导航：清理本种子创建的项后重建（不影响手工新增）
  const removed = await prisma.navItem.deleteMany({ where: { createdBy: SEED_ACTOR } });
  for (const item of NAV_ITEMS) {
    await prisma.navItem.create({
      data: {
        location: item.location,
        label: item.label,
        url: item.url,
        sortOrder: item.sortOrder,
        isActive: true,
        openInNewTab: false,
        createdBy: SEED_ACTOR,
      },
    });
  }
  console.log(
    `[seed:site-content] 导航已重建: ${NAV_ITEMS.length} 项（清理旧种子项 ${removed.count} 个）`,
  );
}
