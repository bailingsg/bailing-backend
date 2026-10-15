import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BlogPostsController } from './blog-posts.controller';
import { BlogPostsService } from './blog-posts.service';
import { BlogCategoriesController } from './blog-categories.controller';
import { BlogCategoriesService } from './blog-categories.service';
import { BlogTagsController } from './blog-tags.controller';
import { BlogTagsService } from './blog-tags.service';

/**
 * CMS Blog 模块（Phase 4.4）。
 *
 * 范围：博客文章 CRUD、分类 CRUD、标签 CRUD、SEO/OG/Twitter 字段管理。
 *
 * 边界：
 *   · 本模块**不接收文件上传**——封面一律通过 coverMediaId 引用 Media Library
 *     中已存在的 MediaAsset（见 blog-posts.service.ts）
 *   · 控制器级 JwtAuthGuard（见各 controller），不在本模块重复注册守卫
 *   · 富文本 XSS 过滤在服务层完成（rich-text.sanitizer.ts）
 */
@Module({
  imports: [PrismaModule],
  controllers: [BlogPostsController, BlogCategoriesController, BlogTagsController],
  providers: [BlogPostsService, BlogCategoriesService, BlogTagsService],
  exports: [BlogPostsService, BlogCategoriesService, BlogTagsService],
})
export class BlogModule {}
