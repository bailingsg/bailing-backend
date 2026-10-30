import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ListProductsQueryDto } from './dto/list-products-query.dto';

/**
 * 产品公开 API（只读）。
 *
 * GET /api/v1/products             产品列表（分页 / 分类 / 精选 / 关键词 search）
 * GET /api/v1/products/:slug       产品详情（按 slug，兼容保留）
 * GET /api/v1/products/by-id/:id   产品详情（按 id，前台详情路由使用）
 *
 * 写入接口（新增 / 编辑产品）属 CMS 阶段，本阶段不提供。
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list(@Query() query: ListProductsQueryDto) {
    return this.productsService.list(query);
  }

  /** 注意：必须声明在 `:slug` 之前，避免被单段参数路由吞掉 */
  @Get('by-id/:id')
  detailById(@Param('id') id: string) {
    return this.productsService.findById(id);
  }

  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug);
  }
}
