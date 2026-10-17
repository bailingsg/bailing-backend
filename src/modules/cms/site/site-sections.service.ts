import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentEntityType, ContentStatus, Prisma, SitePage } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../rbac/audit-log.service';
import type { ActorContext } from '../../rbac/actor-context';
import { RevalidationService } from '../../revalidation/revalidation.service';
import { CmsTags, SITE_PAGE_PATH } from '../../revalidation/cms-tags';
import { normalizeSiteUrl } from './site-url';
import {
  CreateSiteSectionDto,
  ListSiteSectionsQueryDto,
  UpdateSiteSectionDto,
} from './dto/site-section.dto';
import {
  SiteSectionDto,
  SiteSectionListDto,
  toSiteSectionDto,
} from './entities/site.entity';
import {
  getPublishState,
  listEntityRevisions,
  previewEntity,
  publishEntity,
  saveEntityDraft,
  unpublishEntity,
  withPublishMeta,
  type PublishAdapter,
  type PublishState,
} from '../publishing/publishing.engine';

/** 分区行（含媒体关联），用于发布适配器的泛型约束 */
type SiteSectionRow = Prisma.SiteSectionGetPayload<{ include: { media: true } }>;

const SECTION_KEY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * 站点结构化内容分区服务（Phase 4.7）。
 *
 * 安全与数据诚信约束：
 *   · sectionKey / page 组合唯一（同页同键唯一，跨页可复用同名键）
 *   · ctaUrl 与 items[].href 必须通过 URL 安全校验（拒绝 javascript: 等）
 *   · items / stats 为定式结构化字段；白名单外数据在 DTO 层即被拒绝，
 *     读出时（entities）再校验一次，双保险
 *   · 状态流转：DRAFT ↔ PUBLISHED ↔ ARCHIVED；进入 PUBLISHED 时记录 publishedAt
 *   · 所有写操作记审计日志（审计失败不阻断主业务）
 */
@Injectable()
export class SiteSectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly revalidation: RevalidationService,
  ) {}

  /**
   * 站点分区变更后通知前台失效对应页面（Phase 4.8）。
   *
   * 采用「page 路径级 + site tag」双重失效：路径保证该页重新渲染，
   * tag 兜底所有引用 site 数据的视图（如首页聚合区块）。
   */
  private notifyFrontend(page: SitePage): void {
    const path = SITE_PAGE_PATH[page] ?? '/';
    void this.revalidation.invalidate({
      tags: [CmsTags.site],
      paths: [path],
    });
  }

  async list(query: ListSiteSectionsQueryDto): Promise<SiteSectionListDto> {
    const page = Math.max(1, query.pageNum ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.SiteSectionWhereInput = {};
    if (query.page) where.page = query.page;
    if (query.status) where.status = query.status;
    if (query.keyword) {
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { sectionKey: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.siteSection.count({ where }),
      this.prisma.siteSection.findMany({
        where,
        include: { media: true },
        orderBy: [{ page: 'asc' }, { sortOrder: 'asc' }, { sectionKey: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // 一次查询取回本页所有编辑稿，避免 N+1；列表据此展示「有未发布的修改」
    const draftIds = await this.findDraftIds(rows.map((row) => row.id));

    return {
      items: rows.map((row) => toSiteSectionDto(row, draftIds.has(row.id))),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** 批量查询哪些实体存在编辑稿（Phase 1） */
  private async findDraftIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const drafts = await this.prisma.contentDraft.findMany({
      where: { entityType: ContentEntityType.SITE_SECTION, entityId: { in: ids } },
      select: { entityId: true },
    });
    return new Set(drafts.map((draft) => draft.entityId));
  }

  async findById(id: string): Promise<SiteSectionDto> {
    const row = await this.prisma.siteSection.findUnique({
      where: { id },
      include: { media: true },
    });
    if (!row) throw new NotFoundException('Site section not found.');
    const draftIds = await this.findDraftIds([id]);
    return toSiteSectionDto(row, draftIds.has(id));
  }

  async create(
    dto: CreateSiteSectionDto,
    actor: ActorContext,
  ): Promise<SiteSectionDto> {
    this.assertSectionKey(dto.sectionKey);
    await this.assertKeyAvailable(dto.page, dto.sectionKey);
    if (dto.mediaId) await this.assertMediaExists(dto.mediaId);
    const ctaUrl = this.normalizeOptionalUrl(dto.ctaUrl, 'ctaUrl');
    this.assertItemHrefs(dto.items);

    const row = await this.prisma.siteSection.create({
      data: {
        page: dto.page,
        sectionKey: dto.sectionKey,
        eyebrow: dto.eyebrow ?? null,
        title: dto.title ?? null,
        subtitle: dto.subtitle ?? null,
        body: dto.body ?? null,
        mediaId: dto.mediaId ?? null,
        ctaLabel: dto.ctaLabel ?? null,
        ctaUrl,
        items: dto.items ? (dto.items as unknown as Prisma.InputJsonValue) : undefined,
        stats: dto.stats ? (dto.stats as unknown as Prisma.InputJsonValue) : undefined,
        // Phase 1：创建一律为草稿，发布只能经独立 publish 动作
        status: ContentStatus.DRAFT,
        sortOrder: dto.sortOrder ?? 0,
        createdBy: actor.id,
        publishedAt: null,
      },
      include: { media: true },
    });

    await this.audit.record({
      actor,
      action: 'site_section.create',
      targetType: 'SiteSection',
      targetId: row.id,
      summary: `新建站点分区 ${dto.page}/${dto.sectionKey}（DRAFT）`,
    });

    this.notifyFrontend(row.page);

    return toSiteSectionDto(row);
  }

  /**
   * 更新站点分区。
   *
   * ctx.tx 传入时在既有事务内执行（发布流程应用编辑稿时使用）；
   * 否则自行开启事务。status / publishedAt 不在 DTO 中，此处永不触碰。
   */
  async update(
    id: string,
    dto: UpdateSiteSectionDto,
    actor: ActorContext,
    ctx: { tx?: Prisma.TransactionClient; skipNotify?: boolean } = {},
  ): Promise<SiteSectionDto> {
    const existing = await this.prisma.siteSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Site section not found.');

    const db = ctx.tx ?? this.prisma;
    if (dto.mediaId !== undefined && dto.mediaId !== null) {
      await this.assertMediaExists(dto.mediaId, db);
    }
    const ctaUrl =
      dto.ctaUrl === undefined
        ? undefined
        : dto.ctaUrl === null
          ? null
          : this.normalizeOptionalUrl(dto.ctaUrl, 'ctaUrl');
    this.assertItemHrefs(dto.items);

    const apply = (tx: Prisma.TransactionClient) => this.applyUpdate(tx, id, dto, ctaUrl);
    const row = ctx.tx ? await apply(ctx.tx) : await this.prisma.$transaction(apply);

    if (!ctx.skipNotify) {
      await this.audit.record({
        actor,
        action: 'site_section.update',
        targetType: 'SiteSection',
        targetId: row.id,
        summary: `更新站点分区 ${row.page}/${row.sectionKey}`,
      });
      this.notifyFrontend(row.page);
    }

    return toSiteSectionDto(row);
  }

  /** 在事务内落库分区字段，返回带媒体的最新行（不含审计与缓存失效） */
  private async applyUpdate(
    tx: Prisma.TransactionClient,
    id: string,
    dto: UpdateSiteSectionDto,
    ctaUrl: string | null | undefined,
  ) {
    return tx.siteSection.update({
      where: { id },
      data: {
        eyebrow: dto.eyebrow ?? undefined,
        title: dto.title ?? undefined,
        subtitle: dto.subtitle ?? undefined,
        body: dto.body ?? undefined,
        mediaId: dto.mediaId,
        ctaLabel: dto.ctaLabel ?? undefined,
        ctaUrl,
        items:
          dto.items === undefined
            ? undefined
            : dto.items === null
              ? Prisma.DbNull
              : (dto.items as unknown as Prisma.InputJsonValue),
        stats:
          dto.stats === undefined
            ? undefined
            : dto.stats === null
              ? Prisma.DbNull
              : (dto.stats as unknown as Prisma.InputJsonValue),
        // status / publishedAt 不在 DTO 中，此处不触碰
        sortOrder: dto.sortOrder ?? undefined,
      },
      include: { media: true },
    });
  }

  async remove(id: string, actor: ActorContext): Promise<{ id: string }> {
    const existing = await this.prisma.siteSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Site section not found.');

    await this.prisma.$transaction([
      // 通用发布表按 entityType+entityId 关联，无外键 → 随主体一并清理
      this.prisma.contentDraft.deleteMany({ where: { entityType: 'SITE_SECTION', entityId: id } }),
      this.prisma.contentRevision.deleteMany({ where: { entityType: 'SITE_SECTION', entityId: id } }),
      this.prisma.siteSection.delete({ where: { id } }),
    ]);

    await this.audit.record({
      actor,
      action: 'site_section.delete',
      targetType: 'SiteSection',
      targetId: id,
      summary: `删除站点分区 ${existing.page}/${existing.sectionKey}`,
    });

    this.notifyFrontend(existing.page);

    return { id };
  }

  /* --------------------------- 发布工作流 --------------------------- */

  /**
   * 发布适配器：把站点分区接入通用引擎。
   *
   * 发布完整性校验沿用既有规则：已发布分区至少要承载
   * 标题 / 正文 / 卡片之一（防空壳上线）。
   */
  private publishingAdapter(): PublishAdapter<SiteSectionRow> {
    return {
      entityType: 'SITE_SECTION',
      label: '站点分区',
      findRow: async (id) =>
        (await this.prisma.siteSection.findUnique({
          where: { id },
          include: { media: true },
        })) as SiteSectionRow | null,
      applyDraft: async (id, payload, tx) => {
        if (!payload) {
          const row = await tx.siteSection.findUnique({ where: { id }, include: { media: true } });
          if (!row) throw new NotFoundException('Site section not found.');
          return row as SiteSectionRow;
        }
        const dto = payload as UpdateSiteSectionDto;
        if (dto.mediaId !== undefined && dto.mediaId !== null) {
          const media = await tx.mediaAsset.findUnique({
            where: { id: dto.mediaId },
            select: { id: true },
          });
          if (!media) throw new BadRequestException(`媒体资产不存在：${dto.mediaId}`);
        }
        const ctaUrl =
          dto.ctaUrl === undefined
            ? undefined
            : dto.ctaUrl === null
              ? null
              : this.normalizeOptionalUrl(dto.ctaUrl, 'ctaUrl');
        this.assertItemHrefs(dto.items);
        return this.applyUpdate(tx, id, dto, ctaUrl) as Promise<SiteSectionRow>;
      },
      markPublished: async (id, nextVersion, tx) =>
        tx.siteSection.update({
          where: { id },
          data: {
            status: ContentStatus.PUBLISHED,
            // 首次发布写入时间；重新发布沿用首次发布时间（避免 SEO 时间线抖动）
            publishedAt: (await tx.siteSection.findUnique({
              where: { id },
              select: { publishedAt: true },
            }))?.publishedAt ?? new Date(),
            version: { increment: 1 },
            publishedVersion: nextVersion,
          },
          include: { media: true },
        }) as unknown as Promise<SiteSectionRow>,
      markUnpublished: async (id, tx) =>
        tx.siteSection.update({
          where: { id },
          // 保留内容、publishedAt 与发布历史
          data: { status: ContentStatus.UNPUBLISHED, version: { increment: 1 } },
          include: { media: true },
        }) as unknown as Promise<SiteSectionRow>,
      validate: (row) => {
        this.assertPublishable({ title: row.title, body: row.body, items: row.items as unknown[] });
      },
      toSnapshot: (row) => toSiteSectionDto(row as never),
    };
  }

  /** 发布状态快照（供控制器决定「直接改行」还是「写编辑稿」） */
  publishState(id: string): Promise<PublishState> {
    return getPublishState(this.prisma, this.publishingAdapter(), id);
  }

  /** 保存编辑稿（已发布分区不再直接改写线上行） */
  saveDraft(
    id: string,
    dto: UpdateSiteSectionDto,
    actorId: string | null,
    expectedVersion?: number,
  ): Promise<{ draftVersion: number; updatedAt: Date; baseVersion: number }> {
    return saveEntityDraft(
      this.prisma,
      this.publishingAdapter(),
      id,
      dto as Record<string, unknown>,
      actorId,
      expectedVersion,
    );
  }

  /** 发布：把编辑稿应用为线上版本（事务内完成，失败不影响旧版本） */
  async publish(id: string, actor: ActorContext): Promise<SiteSectionDto> {
    const result = await publishEntity(this.prisma, this.publishingAdapter(), id, actor.id);

    await this.audit.record({
      actor,
      action: 'site_section.publish',
      targetType: 'SiteSection',
      targetId: result.row.id,
      summary: `发布站点分区 ${result.row.page}/${result.row.sectionKey}（v${result.publishedVersion}）`,
    });

    this.notifyFrontend(result.row.page);
    return withPublishMeta(toSiteSectionDto(result.row as never, false), result);
  }

  /** 取消发布：保留内容与历史，公开侧立即不可见 */
  async unpublish(id: string, actor: ActorContext): Promise<SiteSectionDto> {
    const result = await unpublishEntity(this.prisma, this.publishingAdapter(), id);

    await this.audit.record({
      actor,
      action: 'site_section.unpublish',
      targetType: 'SiteSection',
      targetId: result.row.id,
      summary: `取消发布站点分区 ${result.row.page}/${result.row.sectionKey}`,
    });

    this.notifyFrontend(result.row.page);
    return withPublishMeta(toSiteSectionDto(result.row as never, false), result);
  }

  /** 预览：线上版本 + 编辑稿（仅后台授权访问） */
  preview(id: string) {
    return previewEntity(this.prisma, this.publishingAdapter(), id, (row) =>
      toSiteSectionDto(row as never),
    );
  }

  /** 发布历史 */
  revisions(id: string) {
    return listEntityRevisions(this.prisma, this.publishingAdapter(), id);
  }

  /* ------------------------------ 内部 ------------------------------ */

  private assertSectionKey(sectionKey: string): void {
    if (!SECTION_KEY_PATTERN.test(sectionKey)) {
      throw new BadRequestException(
        'sectionKey 只能包含小写字母、数字与 . - 分隔（如 home.hero）',
      );
    }
  }

  private async assertKeyAvailable(page: SitePage, sectionKey: string): Promise<void> {
    const existing = await this.prisma.siteSection.findUnique({
      where: { page_sectionKey: { page, sectionKey } },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(`分区键已存在：${page}/${sectionKey}`);
    }
  }

  private async assertMediaExists(
    mediaId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const media = await db.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { id: true },
    });
    if (!media) {
      throw new BadRequestException(`媒体资产不存在：${mediaId}`);
    }
  }

  /** 可选 URL 校验：undefined = 不改动；null = 清空；字符串必须合法 */
  private normalizeOptionalUrl(
    value: string | null | undefined,
    field: string,
  ): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const normalized = normalizeSiteUrl(value);
    if (normalized === null) {
      throw new BadRequestException(
        `${field} 不是合法的链接：仅支持站内相对路径（/xxx）、https 外链或 mailto/tel`,
      );
    }
    return normalized;
  }

  private assertItemHrefs(
    items: CreateSiteSectionDto['items'] | UpdateSiteSectionDto['items'],
  ): void {
    if (!items) return;
    for (const item of items) {
      if (item.href === undefined || item.href === null) continue;
      if (normalizeSiteUrl(item.href) === null) {
        throw new BadRequestException(
          `卡片链接不合法（仅支持站内相对路径 / https / mailto/tel）：${item.href}`,
        );
      }
    }
  }

  /** 发布完整性：已发布分区必须承载实际内容（标题 / 正文 / 卡片至少其一） */
  private assertPublishable(dto: {
    title?: string | null;
    body?: string | null;
    items?: unknown[] | null;
  }): void {
    const hasTitle = typeof dto.title === 'string' && dto.title.trim().length > 0;
    const hasBody = typeof dto.body === 'string' && dto.body.trim().length > 0;
    const hasItems = Array.isArray(dto.items) && dto.items.length > 0;
    if (!hasTitle && !hasBody && !hasItems) {
      // Phase 1：发布校验是业务规则失败（400），不是权限失败（403）
      throw new BadRequestException(
        '发布失败：分区内容不能为空，至少需要标题、正文或卡片之一',
      );
    }
  }
}
