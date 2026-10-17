/**
 * Phase 1 旧数据迁移 / 对账脚本（可重复执行）。
 *
 * 背景：
 *   Phase 1 之前，「发布」就是 PATCH 里带 status=PUBLISHED，实体行即线上内容。
 *   迁移后引入 publishedVersion（0 = 从未发布），控制器据此判断：
 *     · publishedVersion === 0 且无编辑稿 → PATCH 直接改实体行（行即草稿）
 *     · publishedVersion > 0 或有编辑稿     → PATCH 只写 ContentDraft（保存≠发布）
 *
 *   因此迁移前已发布的历史数据必须回填 publishedVersion = 1，否则这些内容
 *   在后台仍然「一保存就上线」，Phase 1 的隔离对它们不生效。
 *
 * 本脚本做的事（每类实体）：
 *   1. 找出 status = 'PUBLISHED' 且 publishedVersion = 0 的行（迁移前已发布）
 *   2. 为每一行写入 ContentRevision v1 快照，note 标注为 legacy-backfill
 *   3. 把这些行的 publishedVersion 置为 1，version + 1（乐观锁基线前移）
 *
 * 幂等性：
 *   · 只处理 publishedVersion = 0 的行 → 重复执行不会重复回填
 *   · 快照 id 由 entityType + entityId + version 决定 → ON CONFLICT DO NOTHING
 *   · 每次执行前后都打印对账数字，可反复核对
 *
 * 快照形状说明（诚实标注）：
 *   历史快照使用**数据库原始行**的 JSON（to_jsonb），并带 legacy 标记。
 *   它不是公开 API 的 DTO 形状，用途是可追溯「迁移那一刻线上是什么」，
 *   不作为一键回滚的数据源；新发布产生的快照才是公开 DTO 形状。
 *
 * 用法：
 *   npx ts-node prisma/scripts/phase1-backfill-publishing.ts            # 演练（只读，默认）
 *   npx ts-node prisma/scripts/phase1-backfill-publishing.ts --apply    # 实际写入
 *   npx ts-node prisma/scripts/phase1-backfill-publishing.ts --apply --verbose
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

interface EntitySpec {
  /** content_revisions.entityType */
  entityType: string;
  /** 数据库表名（固定常量，不来自外部输入） */
  table: string;
  label: string;
  /** 该表是否有 publishedAt 列（Product 没有，只有 updatedAt） */
  hasPublishedAt: boolean;
}

const ENTITIES: EntitySpec[] = [
  { entityType: 'PRODUCT', table: 'products', label: '产品', hasPublishedAt: false },
  { entityType: 'BLOG_POST', table: 'blog_posts', label: '博客文章', hasPublishedAt: true },
  { entityType: 'FACTORY_SECTION', table: 'factory_sections', label: '工厂分区', hasPublishedAt: true },
  { entityType: 'QUALITY_RECORD', table: 'quality_records', label: '质量记录', hasPublishedAt: true },
  { entityType: 'APPLICATION', table: 'applications', label: '应用场景', hasPublishedAt: true },
  { entityType: 'SITE_SECTION', table: 'site_sections', label: '站点分区', hasPublishedAt: true },
];

interface Counts {
  published: number;
  needsBackfill: number;
  revisions: number;
}

async function countFor(spec: EntitySpec): Promise<Counts> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ published: bigint; needs: bigint }>>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'PUBLISHED') AS published,
       COUNT(*) FILTER (WHERE status = 'PUBLISHED' AND "publishedVersion" = 0) AS needs
     FROM "${spec.table}"`,
  );
  const [rev] = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
    `SELECT COUNT(*) AS total FROM content_revisions WHERE "entityType" = $1::"ContentEntityType"`,
    spec.entityType,
  );
  return {
    published: Number(row?.published ?? 0),
    needsBackfill: Number(row?.needs ?? 0),
    revisions: Number(rev?.total ?? 0),
  };
}

/** 单类实体回填：快照 → publishedVersion=1，同一事务内完成 */
async function backfill(spec: EntitySpec): Promise<number> {
  const ids = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "${spec.table}" WHERE status = 'PUBLISHED' AND "publishedVersion" = 0 ORDER BY id`,
  );
  if (ids.length === 0) return 0;

  if (VERBOSE) {
    console.log(`   待回填 ${ids.length} 条：${ids.map((r) => r.id).join(', ')}`);
  }
  if (!APPLY) return ids.length;

  // Product 表没有 publishedAt 列，历史时间回退到 updatedAt
  const publishedAtExpr = spec.hasPublishedAt
    ? 'COALESCE(t."publishedAt", t."updatedAt", now())'
    : 'COALESCE(t."updatedAt", now())';

  await prisma.$transaction(async (tx) => {
    // 1) 先落快照（此时行仍是迁移前的线上内容）
    await tx.$executeRawUnsafe(
      `INSERT INTO content_revisions
         (id, "entityType", "entityId", version, snapshot, action, "publishedById", "publishedAt", note)
       SELECT
         'legacy-' || $1 || '-' || t.id || '-v1',
         $1::"ContentEntityType",
         t.id,
         1,
         jsonb_build_object(
           '_legacy', true,
           '_source', 'phase1-backfill',
           'capturedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'row', to_jsonb(t)
         ),
         'PUBLISH',
         NULL,
         ${publishedAtExpr},
         'legacy-backfill: 迁移前已发布内容，快照为数据库原始行'
       FROM "${spec.table}" t
       WHERE t.status = 'PUBLISHED' AND t."publishedVersion" = 0
       ON CONFLICT ("entityType", "entityId", version) DO NOTHING`,
      spec.entityType,
    );

    // 2) 再前移版本基线：此后 PATCH 只会写编辑稿
    await tx.$executeRawUnsafe(
      `UPDATE "${spec.table}"
         SET "publishedVersion" = 1, version = version + 1
       WHERE status = 'PUBLISHED' AND "publishedVersion" = 0`,
    );
  });

  return ids.length;
}

/** 对账：孤儿编辑稿 / 孤儿历史（实体已删除但通用表残留） */
async function reconcileOrphans(): Promise<void> {
  for (const spec of ENTITIES) {
    const [draftOrphan] = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
      `SELECT COUNT(*) AS total FROM content_drafts d
        WHERE d."entityType" = $1::"ContentEntityType"
          AND NOT EXISTS (SELECT 1 FROM "${spec.table}" t WHERE t.id = d."entityId")`,
      spec.entityType,
    );
    const [revOrphan] = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
      `SELECT COUNT(*) AS total FROM content_revisions r
        WHERE r."entityType" = $1::"ContentEntityType"
          AND NOT EXISTS (SELECT 1 FROM "${spec.table}" t WHERE t.id = r."entityId")`,
      spec.entityType,
    );
    const drafts = Number(draftOrphan?.total ?? 0);
    const revisions = Number(revOrphan?.total ?? 0);
    if (drafts > 0 || revisions > 0) {
      console.log(
        `   ⚠ ${spec.label}：孤儿编辑稿 ${drafts} 条、孤儿历史 ${revisions} 条` +
          '（实体已删除；服务层删除时会连带清理，历史遗留可手工核对）',
      );
    }
  }
}

async function main(): Promise<void> {
  console.log('=== Phase 1 发布数据回填 / 对账 ===');
  console.log(APPLY ? '模式：APPLY（会写入数据库）' : '模式：DRY-RUN（只读演练，加 --apply 才写入）');
  console.log('');

  const before: Record<string, Counts> = {};
  let totalNeeds = 0;

  console.log('[1/3] 迁移前盘点');
  for (const spec of ENTITIES) {
    const counts = await countFor(spec);
    before[spec.entityType] = counts;
    totalNeeds += counts.needsBackfill;
    console.log(
      `   ${spec.label.padEnd(6)} 已发布 ${String(counts.published).padStart(4)} 条` +
        ` / 需回填 ${String(counts.needsBackfill).padStart(4)} 条` +
        ` / 现有历史 ${String(counts.revisions).padStart(4)} 条`,
    );
  }
  console.log('');

  console.log('[2/3] 回填');
  let processed = 0;
  for (const spec of ENTITIES) {
    const n = await backfill(spec);
    processed += n;
    console.log(`   ${spec.label.padEnd(6)} ${APPLY ? '已回填' : '待回填'} ${n} 条`);
  }
  console.log('');

  console.log('[3/3] 迁移后对账');
  for (const spec of ENTITIES) {
    const after = await countFor(spec);
    const delta = after.revisions - before[spec.entityType].revisions;
    console.log(
      `   ${spec.label.padEnd(6)} 需回填剩余 ${after.needsBackfill} 条` +
        ` / 历史 +${delta} 条（累计 ${after.revisions}）`,
    );
  }
  console.log('');
  await reconcileOrphans();

  console.log('');
  if (!APPLY) {
    console.log(`演练结束：共 ${totalNeeds} 条历史已发布内容需要回填。加 --apply 执行写入。`);
  } else {
    console.log(`完成：共处理 ${processed} 条。重复执行本脚本不会再产生变更（幂等）。`);
  }
}

main()
  .catch((error: unknown) => {
    console.error('回填失败：', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
