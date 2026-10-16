import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentStatus, Prisma, SitePage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PublicSiteSection,
  toPublicSiteSection,
} from './entities/public-site.entity';

/**
 * 站点结构化内容公开只读服务（Phase 4.7）。
 *
 * 发布规则（硬约束）：
 *   · **只返回 status = PUBLISHED** 的分区，草稿 / 归档不进入响应
 *   · stats / items 均为定式结构化字段，经 entities 层白名单解析
 *   · 媒体引用只透出 url / altText 等展示字段（无 storageKey）
 */
@Injectable()
export class PublicSiteService {
  constructor(private readonly prisma: PrismaService) {}

  /** 某页面（HOME / ABOUT / CONTACT）的全部已发布分区，按 sortOrder 升序 */
  async sectionsByPage(page: SitePage): Promise<{ items: PublicSiteSection[] }> {
    const rows = await this.prisma.siteSection.findMany({
      where: { page, status: ContentStatus.PUBLISHED },
      include: { media: true },
      orderBy: [{ sortOrder: 'asc' }, { sectionKey: 'asc' }],
    });
    return { items: rows.map(toPublicSiteSection) };
  }

  /** 单个已发布分区（按页面 + 分区键）——不存在或未发布返回 404 */
  async sectionByKey(page: SitePage, sectionKey: string): Promise<PublicSiteSection> {
    const row = await this.prisma.siteSection.findFirst({
      where: { page, sectionKey, status: ContentStatus.PUBLISHED },
      include: { media: true },
    });
    if (!row) throw new NotFoundException('Site section not found.');
    return toPublicSiteSection(row);
  }
}

/** 站内导航公开只读查询 */
@Injectable()
export class PublicNavService {
  constructor(private readonly prisma: PrismaService) {}

  /** 指定位置（HEADER / FOOTER）的全部启用导航项 */
  async items(location: 'HEADER' | 'FOOTER') {
    const where: Prisma.NavItemWhereInput = {
      location,
      isActive: true,
    };
    const rows = await this.prisma.navItem.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        label: true,
        url: true,
        sortOrder: true,
        openInNewTab: true,
      },
    });
    return { items: rows };
  }
}
