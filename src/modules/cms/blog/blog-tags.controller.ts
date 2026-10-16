import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { CreateBlogTagDto, UpdateBlogTagDto } from './dto/blog-tag.dto';
import { BlogTagsService } from './blog-tags.service';
import type { BlogTagDto } from './entities/blog.entity';

/**
 * 博客标签 CMS API（Phase 4.4）。
 *
 *   GET    /api/v1/cms/blog/tags       列表（含引用计数）
 *   POST   /api/v1/cms/blog/tags       创建
 *   PATCH  /api/v1/cms/blog/tags/:id   更新
 *   DELETE /api/v1/cms/blog/tags/:id   删除（级联移除文章关联）
 *
 * 未来权限扩展：RBAC 落地时挂 @RequirePermission('BLOG_TAG_MANAGE')。
 */
@Controller('cms/blog/tags')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BlogTagsController {
  constructor(private readonly tagsService: BlogTagsService) {}

  @Get()
  @RequirePermissions('blog.read')
  list(): Promise<BlogTagDto[]> {
    return this.tagsService.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('blog.create')
  create(@Body() dto: CreateBlogTagDto): Promise<BlogTagDto> {
    return this.tagsService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('blog.update')
  update(@Param('id') id: string, @Body() dto: UpdateBlogTagDto): Promise<BlogTagDto> {
    return this.tagsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('blog.delete')
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.tagsService.remove(id);
  }
}
