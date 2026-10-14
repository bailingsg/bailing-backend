import { Controller, Get } from '@nestjs/common';
import { CategoriesService } from './categories.service';

/**
 * 产品分类公开 API（只读）。
 * GET /api/v1/categories —— 供 /products 页面分类筛选器使用。
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  list() {
    return this.categoriesService.list();
  }
}
