import { Controller, Get, Query } from '@nestjs/common';
import { PublicMediaService } from './public-media.service';
import { PublicMediaListQueryDto } from './dto/public-media-query.dto';

/**
 * 公开媒体 API（只读，无需登录，Phase 5.6）。
 *
 *   GET /api/v1/public/media?usage=FACTORY&limit=24   按用途取图
 *
 * 设计动机：媒体库上传时已选用途（工厂 / 生产 / 装车 / 展会 / 应用场景 …），
 * 前台页面据此**自动聚合相关图片**，不必在 Factory / Quality 等业务表里
 * 重复登记同一张图。未分类（usage 为空）的资产一律不下发。
 */
@Controller('public/media')
export class PublicMediaController {
  constructor(private readonly publicMediaService: PublicMediaService) {}

  @Get()
  list(@Query() query: PublicMediaListQueryDto) {
    return this.publicMediaService.list(query);
  }
}
