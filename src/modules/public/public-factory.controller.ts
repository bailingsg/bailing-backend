import { Controller, Get, Param, Query } from '@nestjs/common';
import { PublicFactoryService } from './public-factory.service';
import { PublicFactoryListQueryDto } from './dto/public-list-query.dto';

/**
 * 工厂实力公开 API（只读，无需登录）。
 *
 *   GET /api/v1/public/factory          公开分区列表（仅 PUBLISHED）
 *   GET /api/v1/public/factory/:slug    公开分区详情
 *
 * 发布规则：草稿 / 下架分区的详情请求返回 404，不泄漏其存在性。
 */
@Controller('public/factory')
export class PublicFactoryController {
  constructor(private readonly publicFactoryService: PublicFactoryService) {}

  @Get()
  list(@Query() query: PublicFactoryListQueryDto) {
    return this.publicFactoryService.list(query);
  }

  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.publicFactoryService.findBySlug(slug);
  }
}
