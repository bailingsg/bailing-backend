import { Module } from '@nestjs/common';
import { SeoAdminController } from './seo-admin.controller';
import { SeoPublicController } from './seo-public.controller';
import { SeoProfileService } from './seo-profile.service';
import { SeoSettingsService } from './seo-settings.service';
import { SeoRedirectService } from './seo-redirect.service';
import { SeoAuditService } from './seo-audit.service';
import { SeoSitemapService } from './seo-sitemap.service';
import { SeoSchemaService } from './seo-schema.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RevalidationModule } from '../revalidation/revalidation.module';

/**
 * SEO 模块（Phase 5.0）
 *
 * 统一管理：SEO 档案（产品 / 博客 / 页面 / 分类）、全局设置、重定向、
 * 审计引擎、sitemap / robots 生成、公开解析 API。
 * RevalidationModule 为 @Global，直接注入 RevalidationService 即可。
 */
@Module({
  imports: [PrismaModule, RevalidationModule],
  controllers: [SeoAdminController, SeoPublicController],
  providers: [
    SeoProfileService,
    SeoSettingsService,
    SeoRedirectService,
    SeoAuditService,
    SeoSitemapService,
    SeoSchemaService,
  ],
  exports: [SeoProfileService, SeoSettingsService, SeoSitemapService],
})
export class SeoModule {}
