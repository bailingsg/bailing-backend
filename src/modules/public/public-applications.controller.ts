import { Controller, Get, Param, Query } from '@nestjs/common';
import { PublicApplicationsService } from './public-applications.service';
import { PublicApplicationsListQueryDto } from './dto/public-list-query.dto';

/**
 * 产品应用场景公开 API（只读，无需登录）。
 *
 *   GET /api/v1/public/applications          公开应用场景列表（仅 PUBLISHED）
 *   GET /api/v1/public/applications/:slug    公开应用场景详情
 *
 * 发布规则：草稿 / 下架场景的详情请求返回 404；详情内只返回已发布产品。
 */
@Controller('public/applications')
export class PublicApplicationsController {
  constructor(private readonly publicApplicationsService: PublicApplicationsService) {}

  @Get()
  list(@Query() query: PublicApplicationsListQueryDto) {
    return this.publicApplicationsService.list(query);
  }

  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.publicApplicationsService.findBySlug(slug);
  }
}
