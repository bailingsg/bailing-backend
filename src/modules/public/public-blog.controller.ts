import { Controller, Get, Param, Query } from '@nestjs/common';
import { PublicBlogService } from './public-blog.service';
import { PublicBlogListQueryDto } from './dto/public-list-query.dto';

/**
 * 博客公开 API（Phase 4.7，只读，无需登录）。
 *
 *   GET /api/v1/public/blog               文章列表（分页 / 分类 / 标签 / 精选）
 *   GET /api/v1/public/blog/categories    分类列表（含已发布文章数）
 *   GET /api/v1/public/blog/:slug         文章详情
 *
 * 发布规则（硬约束）：
 *   · 只返回 PUBLISHED；草稿 / 归档不出现在任何响应中
 *   · 未发布 slug 的详情请求返回 404，不泄漏内容存在性
 *   · DTO 白名单：不含 authorId / storageKey / 内部字段
 *   · 路由顺序：categories 必须在 :slug 之前声明
 */
@Controller('public/blog')
export class PublicBlogController {
  constructor(private readonly publicBlogService: PublicBlogService) {}

  @Get('categories')
  categories() {
    return this.publicBlogService.categories();
  }

  @Get()
  list(@Query() query: PublicBlogListQueryDto) {
    return this.publicBlogService.list(query);
  }

  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.publicBlogService.findBySlug(slug);
  }
}
