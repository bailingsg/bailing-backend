import { Controller, Get, Param, ParseEnumPipe, Query } from '@nestjs/common';
import { SitePage } from '@prisma/client';
import { PublicSiteService, PublicNavService } from './public-site.service';
import { ListPublicNavQueryDto } from './dto/public-site-query.dto';

/**
 * 站点内容 / 导航公开 API（Phase 4.7，只读，无需登录）。
 *
 *   GET /api/v1/public/site/:page            页面已发布分区（HOME / ABOUT / CONTACT）
 *   GET /api/v1/public/site/:page/:sectionKey 单个已发布分区
 *   GET /api/v1/public/navigation?location=   启用中的导航项（HEADER / FOOTER）
 *
 * 发布规则（硬约束）：
 *   · 分区只返回 PUBLISHED；未发布 / 不存在统一 404，不泄漏存在性
 *   · 导航只返回 isActive=true 的项
 *   · URL 均为 CMS 写入时已校验的安全链接；前台渲染时 openInNewTab 项
 *     必须补 rel="noopener noreferrer"
 */
@Controller('public')
export class PublicSiteController {
  constructor(
    private readonly site: PublicSiteService,
    private readonly nav: PublicNavService,
  ) {}

  @Get('site/:page')
  sections(
    @Param('page', new ParseEnumPipe(SitePage)) page: SitePage,
  ) {
    return this.site.sectionsByPage(page);
  }

  @Get('site/:page/:sectionKey')
  section(
    @Param('page', new ParseEnumPipe(SitePage)) page: SitePage,
    @Param('sectionKey') sectionKey: string,
  ) {
    return this.site.sectionByKey(page, sectionKey);
  }

  @Get('navigation')
  navigation(@Query() query: ListPublicNavQueryDto) {
    return this.nav.items(query.location ?? 'HEADER');
  }
}
