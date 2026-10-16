import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentStatus, Prisma, SitePage } from '@prisma/client';
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

    return {
      items: rows.map(toSiteSectionDto),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async findById(id: string): Promise<SiteSectionDto> {
    const row = await this.prisma.siteSection.findUnique({
      where: { id },
      include: { media: true },
    });
    if (!row) throw new NotFoundException('Site section not found.');
    return toSiteSectionDto(row);
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
    if (dto.status === ContentStatus.PUBLISHED) {
      this.assertPublishable(dto);
    }

    const status = dto.status ?? ContentStatus.DRAFT;

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
        status,
        sortOrder: dto.sortOrder ?? 0,
        createdBy: actor.id,
        publishedAt: status === ContentStatus.PUBLISHED ? new Date() : null,
      },
      include: { media: true },
    });

    await this.audit.record({
      actor,
      action: 'site_section.create',
      targetType: 'SiteSection',
      targetId: row.id,
      summary: `新建站点分区 ${dto.page}/${dto.sectionKey}（${status}）`,
    });

    this.notifyFrontend(row.page);

    return toSiteSectionDto(row);
  }

  async update(
    id: string,
    dto: UpdateSiteSectionDto,
    actor: ActorContext,
  ): Promise<SiteSectionDto> {
    const existing = await this.prisma.siteSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Site section not found.');

    if (dto.mediaId !== undefined && dto.mediaId !== null) {
      await this.assertMediaExists(dto.mediaId);
    }
    const ctaUrl =
      dto.ctaUrl === undefined
        ? undefined
        : dto.ctaUrl === null
          ? null
          : this.normalizeOptionalUrl(dto.ctaUrl, 'ctaUrl');
    this.assertItemHrefs(dto.items);

    const status = dto.status ?? existing.status;
    // 发布前的完整性校验：PUBLISHED 分区至少要有标题或正文（防空壳上线）
    if (status === ContentStatus.PUBLISHED) {
      this.assertPublishable({
        title: dto.title ?? existing.title,
        body: dto.body ?? existing.body,
        items: dto.items ?? undefined,
      });
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.siteSection.update({
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
          status,
          sortOrder: dto.sortOrder ?? undefined,
          // 重新发布（ARCHIVED/DRAFT → PUBLISHED）刷新发布时间；
          // 持续发布中不重复刷新；离开 PUBLISHED 保留历史时间
          publishedAt:
            status === ContentStatus.PUBLISHED && existing.status !== ContentStatus.PUBLISHED
              ? new Date()
              : undefined,
        },
        include: { media: true },
      });
      return updated;
    });

    const statusChanged = existing.status !== row.status;
    await this.audit.record({
      actor,
      action: statusChanged ? 'site_section.status' : 'site_section.update',
      targetType: 'SiteSection',
      targetId: row.id,
      diff: statusChanged
        ? { before: { status: existing.status }, after: { status: row.status } }
        : undefined,
      summary: statusChanged
        ? `站点分区 ${row.page}/${row.sectionKey} 状态 ${existing.status} → ${row.status}`
        : `更新站点分区 ${row.page}/${row.sectionKey}`,
    });

    this.notifyFrontend(row.page);

    return toSiteSectionDto(row);
  }

  async remove(id: string, actor: ActorContext): Promise<{ id: string }> {
    const existing = await this.prisma.siteSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Site section not found.');

    await this.prisma.siteSection.delete({ where: { id } });

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

  private async assertMediaExists(mediaId: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findUnique({
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
      throw new ForbiddenException(
        '发布内容不能为空：已发布分区至少需要标题、正文或卡片之一',
      );
    }
  }
}
