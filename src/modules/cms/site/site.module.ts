import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SiteController } from './site.controller';
import { SiteSectionsService } from './site-sections.service';
import { NavItemsService } from './nav-items.service';

/**
 * 站点内容模块（Phase 4.7）：首页 / 关于我们 / 联系页的结构化分区 + 站内导航。
 *
 * 与 Factory / Quality / Applications 的差异：内容形态是**定式字段**
 * （eyebrow / title / subtitle / body / media / cta / items / stats），
 * 不是页面构建器；每个分区由 sectionKey 语义定位（如 home.hero）。
 *
 * 说明：RbacModule 为 @Global（RbacService / AuditLogService 全局可注入），无需 import。
 */
@Module({
  imports: [PrismaModule],
  controllers: [SiteController],
  providers: [SiteSectionsService, NavItemsService],
  exports: [SiteSectionsService, NavItemsService],
})
export class SiteModule {}
