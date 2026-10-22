/**
 * 回填脚本：按「现有引用关系」为媒体资源补上用途分类（Phase 5.6）。
 *
 * 背景：
 *   Phase 5.6 给 media_assets 增加了 usage（文章 / 产品 / 证书 / 工厂 / 生产 /
 *   装车 / 展会 / 应用场景 / 站点配图 / 其他）。存量图片在上传时没有这个字段，
 *   全部是「未分类」，媒体库按用途筛选会一片空白。
 *
 * 归类依据（只依据**数据库里已有的引用关系**，不做任何猜测）：
 *   · ProductImage.url              → PRODUCT
 *   · QualityRecord.mediaId         → CERTIFICATE
 *   · FactoryImage.mediaId          → 按所属分区 sectionType 映射：
 *                                     OVERVIEW / FACILITY → FACTORY
 *                                     EQUIPMENT / PRODUCTION → PRODUCTION
 *                                     LOADING → LOADING
 *                                     EXHIBITION → EXHIBITION
 *   · FactorySection.coverMediaId   → 同上映射
 *   · Application.coverMediaId      → APPLICATION
 *   · BlogPost.coverMediaId         → BLOG
 *   · SiteSection.mediaId           → SITE
 *
 * 同一张图可能被多处引用（例如既是产品图又是文章封面）：按下面的优先级取第一个命中，
 * 优先级 = 该用途对「图片本身内容」的约束强度（产品图/证书图最具体，站点配图最泛）。
 * 已被人工设置过 usage 的资产**一律不覆盖**（幂等，可反复运行）。
 *
 * 用法：
 *   npx ts-node prisma/scripts/classify-media-usage.ts            # dry-run（只打印）
 *   npx ts-node prisma/scripts/classify-media-usage.ts --apply    # 写入
 */
import { MediaUsage, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** 命中优先级：越靠前越具体 */
const PRIORITY: MediaUsage[] = [
  MediaUsage.PRODUCT,
  MediaUsage.CERTIFICATE,
  MediaUsage.LOADING,
  MediaUsage.PRODUCTION,
  MediaUsage.FACTORY,
  MediaUsage.EXHIBITION,
  MediaUsage.APPLICATION,
  MediaUsage.BLOG,
  MediaUsage.SITE,
];

/** FactorySectionType → MediaUsage */
const SECTION_USAGE: Record<string, MediaUsage> = {
  OVERVIEW: MediaUsage.FACTORY,
  FACILITY: MediaUsage.FACTORY,
  EQUIPMENT: MediaUsage.PRODUCTION,
  PRODUCTION: MediaUsage.PRODUCTION,
  LOADING: MediaUsage.LOADING,
  EXHIBITION: MediaUsage.EXHIBITION,
};

interface AssetRef {
  id: string;
  url: string;
  filename: string;
  usage: MediaUsage | null;
}

/** url 命中判定：精确相等，或以 /<filename> 结尾（兼容基地址 / CDN 域名变化） */
function matches(asset: AssetRef, url: string | null | undefined): boolean {
  if (!url) return false;
  return url === asset.url || url.endsWith(`/${asset.filename}`);
}

async function main(): Promise<void> {
  const assets = await prisma.mediaAsset.findMany({
    select: { id: true, url: true, filename: true, usage: true },
  });
  console.log(`[classify] 媒体总数 ${assets.length}，已有用途 ${assets.filter((a) => a.usage).length}`);

  // 建立「资产 id → 命中的用途集合」
  const hits = new Map<string, Set<MediaUsage>>();
  const hit = (assetId: string, usage: MediaUsage) => {
    const set = hits.get(assetId) ?? new Set<MediaUsage>();
    set.add(usage);
    hits.set(assetId, set);
  };

  // 1) 产品图（按 url / 文件名后缀匹配）
  const productImages = await prisma.productImage.findMany({ select: { url: true } });
  for (const asset of assets) {
    if (productImages.some((image) => matches(asset, image.url))) hit(asset.id, MediaUsage.PRODUCT);
  }

  // 2) 质量证书 / 检测报告（外键）
  const qualityRecords = await prisma.qualityRecord.findMany({
    where: { mediaId: { not: null } },
    select: { mediaId: true },
  });
  for (const record of qualityRecords) {
    if (record.mediaId) hit(record.mediaId, MediaUsage.CERTIFICATE);
  }

  // 3) 工厂图库（按所属分区类型映射）
  const factoryImages = await prisma.factoryImage.findMany({
    select: { mediaId: true, section: { select: { sectionType: true } } },
  });
  for (const image of factoryImages) {
    const usage = SECTION_USAGE[image.section.sectionType];
    if (usage) hit(image.mediaId, usage);
  }

  // 4) 工厂分区封面
  const factorySections = await prisma.factorySection.findMany({
    where: { coverMediaId: { not: null } },
    select: { coverMediaId: true, sectionType: true },
  });
  for (const section of factorySections) {
    const usage = SECTION_USAGE[section.sectionType];
    if (section.coverMediaId && usage) hit(section.coverMediaId, usage);
  }

  // 5) 应用场景封面
  const applications = await prisma.application.findMany({
    where: { coverMediaId: { not: null } },
    select: { coverMediaId: true },
  });
  for (const application of applications) {
    if (application.coverMediaId) hit(application.coverMediaId, MediaUsage.APPLICATION);
  }

  // 6) 文章封面
  const posts = await prisma.blogPost.findMany({
    where: { coverMediaId: { not: null } },
    select: { coverMediaId: true },
  });
  for (const post of posts) {
    if (post.coverMediaId) hit(post.coverMediaId, MediaUsage.BLOG);
  }

  // 7) 站点分区配图
  const sections = await prisma.siteSection.findMany({
    where: { mediaId: { not: null } },
    select: { mediaId: true },
  });
  for (const section of sections) {
    if (section.mediaId) hit(section.mediaId, MediaUsage.SITE);
  }

  // 汇总：按优先级取第一个命中；已有人工设置的跳过
  const updates: { id: string; usage: MediaUsage }[] = [];
  for (const asset of assets) {
    if (asset.usage) continue; // 人工设置过 → 不覆盖
    const set = hits.get(asset.id);
    if (!set || set.size === 0) continue;
    const chosen = PRIORITY.find((usage) => set.has(usage));
    if (chosen) updates.push({ id: asset.id, usage: chosen });
  }

  const counts = new Map<MediaUsage, number>();
  for (const update of updates) counts.set(update.usage, (counts.get(update.usage) ?? 0) + 1);

  console.log(`[classify] 待回填 ${updates.length} 张`);
  for (const usage of PRIORITY) {
    const count = counts.get(usage) ?? 0;
    if (count > 0) console.log(`  ${usage.padEnd(12)} ${count}`);
  }
  const untouched = assets.length - updates.length - assets.filter((a) => a.usage).length;
  console.log(`  未命中任何引用（保持未分类）${untouched}`);

  if (!APPLY) {
    console.log('[classify] dry-run：未写入。确认无误后加 --apply 落库。');
    return;
  }

  let written = 0;
  for (const update of updates) {
    await prisma.mediaAsset.update({ where: { id: update.id }, data: { usage: update.usage } });
    written += 1;
  }
  console.log(`[classify] 已写入 ${written} 条`);
}

main()
  .catch((error) => {
    console.error('[classify] 失败：', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
