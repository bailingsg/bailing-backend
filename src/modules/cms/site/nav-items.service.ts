import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../rbac/audit-log.service';
import type { ActorContext } from '../../rbac/actor-context';
import { RevalidationService } from '../../revalidation/revalidation.service';
import { CmsTags } from '../../revalidation/cms-tags';
import { normalizeSiteUrl } from './site-url';
import { CreateNavItemDto, ListNavItemsQueryDto, UpdateNavItemDto } from './dto/nav-item.dto';
import { NavItemDto, NavItemListDto, toNavItemDto } from './entities/site.entity';

/**
 * 站内导航项服务（Phase 4.7）。
 *
 * 页眉 / 页脚链接全部由 CMS 驱动（替换前台硬编码导航）。
 *
 * 安全约束：
 *   · url 必须通过 URL 安全校验（拒绝 javascript: / data: / http 混合内容 /
 *     protocol-relative 外跳），保存时即强制
 *   · openInNewTab 仅作标记，前台渲染时负责补 rel="noopener noreferrer"
 *   · 所有写操作记审计日志（审计失败不阻断主业务）
 */
@Injectable()
export class NavItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly revalidation: RevalidationService,
  ) {}

  /**
   * 导航变更后通知前台失效（Phase 4.8）。
   *
   * 导航渲染在根布局（Header / Footer / 移动端菜单），影响**全站每一页**，
   * 因此以 layout 粒度失效根路径 —— 一次调用覆盖整站。
   */
  private notifyFrontend(): void {
    void this.revalidation.invalidate({
      tags: [CmsTags.navigation],
      paths: ['/'],
      revalidateLayout: true,
    });
  }

  async list(query: ListNavItemsQueryDto): Promise<NavItemListDto> {
    const where: Prisma.NavItemWhereInput = {};
    if (query.location) where.location = query.location;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    const rows = await this.prisma.navItem.findMany({
      where,
      orderBy: [{ location: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return { items: rows.map(toNavItemDto), total: rows.length };
  }

  async create(dto: CreateNavItemDto, actor: ActorContext): Promise<NavItemDto> {
    const url = normalizeSiteUrl(dto.url);
    if (url === null) {
      throw new BadRequestException(
        '链接不合法：仅支持站内相对路径（/xxx）、https 外链或 mailto/tel',
      );
    }

    const row = await this.prisma.navItem.create({
      data: {
        location: dto.location,
        label: dto.label,
        url,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
        openInNewTab: dto.openInNewTab ?? false,
        createdBy: actor.id,
      },
    });

    await this.audit.record({
      actor,
      action: 'nav_item.create',
      targetType: 'NavItem',
      targetId: row.id,
      summary: `新建${dto.location === 'HEADER' ? '页眉' : '页脚'}导航「${dto.label}」→ ${url}`,
    });

    this.notifyFrontend();

    return toNavItemDto(row);
  }

  async update(id: string, dto: UpdateNavItemDto, actor: ActorContext): Promise<NavItemDto> {
    const existing = await this.prisma.navItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Nav item not found.');

    let url: string | undefined;
    if (dto.url !== undefined) {
      const normalized = normalizeSiteUrl(dto.url);
      if (normalized === null) {
        throw new BadRequestException(
          '链接不合法：仅支持站内相对路径（/xxx）、https 外链或 mailto/tel',
        );
      }
      url = normalized;
    }

    const row = await this.prisma.navItem.update({
      where: { id },
      data: {
        label: dto.label,
        url,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
        openInNewTab: dto.openInNewTab,
      },
    });

    await this.audit.record({
      actor,
      action: 'nav_item.update',
      targetType: 'NavItem',
      targetId: id,
      summary: `更新导航「${row.label}」→ ${row.url}`,
    });

    this.notifyFrontend();

    return toNavItemDto(row);
  }

  async remove(id: string, actor: ActorContext): Promise<{ id: string }> {
    const existing = await this.prisma.navItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Nav item not found.');

    await this.prisma.navItem.delete({ where: { id } });

    await this.audit.record({
      actor,
      action: 'nav_item.delete',
      targetType: 'NavItem',
      targetId: id,
      summary: `删除导航「${existing.label}」→ ${existing.url}`,
    });

    this.notifyFrontend();

    return { id };
  }
}
