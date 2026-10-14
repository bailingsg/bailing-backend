import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { ProductCategoriesService } from './product-categories.service';
import type { CmsCategoryDto } from './entities/product.entity';

/**
 * 产品分类 CMS API。
 *
 *   GET    /api/v1/cms/product-categories     列表（含产品计数）
 *   POST   /api/v1/cms/product-categories     创建
 *   PATCH  /api/v1/cms/product-categories/:id 更新
 *   DELETE /api/v1/cms/product-categories/:id 删除（有产品时 400）
 *
 * 控制器级 JwtAuthGuard：本控制器所有接口默认要求登录。
 */
@Controller('cms/product-categories')
@UseGuards(JwtAuthGuard)
export class ProductCategoriesController {
  constructor(private readonly categoriesService: ProductCategoriesService) {}

  @Get()
  list(): Promise<CmsCategoryDto[]> {
    return this.categoriesService.list();
  }

  @Post()
  create(@Body() dto: CreateCategoryDto): Promise<CmsCategoryDto> {
    return this.categoriesService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto): Promise<CmsCategoryDto> {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.categoriesService.remove(id);
  }
}
