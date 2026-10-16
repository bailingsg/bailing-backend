import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { CreateBlogPostDto, UpdateBlogPostDto } from './dto/blog-post.dto';
import { ListBlogPostsQueryDto } from './dto/list-blog-posts-query.dto';
import { BlogPostsService } from './blog-posts.service';
import type { BlogPostDetailDto, PaginatedBlogPostsDto } from './entities/blog.entity';

/** 已鉴权请求（JwtAuthGuard 保证 user 存在） */
interface AuthedRequest {
  user: { id: string };
}

/**
 * 博客文章 CMS API（Phase 4.4，控制器级 JwtAuthGuard，全部要求登录）。
 *
 *   GET    /api/v1/cms/blog/posts        列表（page/limit/keyword/status/categoryId/tagId/featured）
 *   POST   /api/v1/cms/blog/posts        创建
 *   GET    /api/v1/cms/blog/posts/:id    详情
 *   PATCH  /api/v1/cms/blog/posts/:id    更新
 *   DELETE /api/v1/cms/blog/posts/:id    删除
 *
 * 未来权限扩展：本控制器仅做「登录校验」，不写死管理员角色。
 * 引入 RBAC 时在此挂 `@RequirePermission('BLOG_READ' | 'BLOG_CREATE' | 'BLOG_EDIT' | 'BLOG_DELETE')`
 * 即可，服务层与数据层无需改动。
 */
@Controller('cms/blog/posts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BlogPostsController {
  constructor(private readonly postsService: BlogPostsService) {}

  @Get()
  @RequirePermissions('blog.read')
  list(@Query() query: ListBlogPostsQueryDto): Promise<PaginatedBlogPostsDto> {
    return this.postsService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('blog.create')
  create(
    @Body() dto: CreateBlogPostDto,
    @Req() request: AuthedRequest,
  ): Promise<BlogPostDetailDto> {
    return this.postsService.create(dto, request.user.id);
  }

  @Get(':id')
  @RequirePermissions('blog.read')
  detail(@Param('id') id: string): Promise<BlogPostDetailDto> {
    return this.postsService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('blog.update')
  update(@Param('id') id: string, @Body() dto: UpdateBlogPostDto): Promise<BlogPostDetailDto> {
    return this.postsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('blog.delete')
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.postsService.remove(id);
  }
}
