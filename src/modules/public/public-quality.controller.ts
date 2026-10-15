import { Controller, Get, Query } from '@nestjs/common';
import { PublicQualityService } from './public-quality.service';
import { PublicQualityListQueryDto } from './dto/public-list-query.dto';

/**
 * 质量体系公开 API（只读，无需登录）。
 *
 *   GET /api/v1/public/quality    公开质量记录列表（仅 PUBLISHED）
 *
 * 发布规则：未发布的认证 / 报告绝不进入公开响应。
 * 质量详情页归属取决于记录类型（内部类记录不进入公开列表），故公开侧只提供列表；
 * 具体详情由前端按需呈现，服务端仅暴露已发布的展示字段。
 */
@Controller('public/quality')
export class PublicQualityController {
  constructor(private readonly publicQualityService: PublicQualityService) {}

  @Get()
  list(@Query() query: PublicQualityListQueryDto) {
    return this.publicQualityService.list(query);
  }
}
