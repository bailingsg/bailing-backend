import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CreateBlogCategoryDto, UpdateBlogCategoryDto } from './dto/blog-category.dto';
import { BlogCategoriesService } from './blog-categories.service';
import type { BlogCategoryDto } from './entities/blog.entity';

/**
 * 博客分类 CMS API（Phase 4.4）。
 *
 *   GET    /api/v1/cms/blog/categories       列表（含文章计数）
 *   POST   /api/v1/cms/blog/categories       创建
 *   PATCH  /api/v1/cms/blog/categories/:id   更新（含启用/禁用）
 *   DELETE /api/v1/cms/blog/categories/:id   删除（有文章时 400）
 *
 * 未来权限扩展：RBAC 落地时挂 @RequirePermission('BLOG_CATEGORY_MANAGE')。
 */
@Controller('cms/blog/categories')
@UseGuards(JwtAuthGuard)
export class BlogCategoriesController {
  constructor(private readonly categoriesService: BlogCategoriesService) {}

  @Get()
  list(): Promise<BlogCategoryDto[]> {
    return this.categoriesService.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateBlogCategoryDto): Promise<BlogCategoryDto> {
    return this.categoriesService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBlogCategoryDto): Promise<BlogCategoryDto> {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.categoriesService.remove(id);
  }
}
