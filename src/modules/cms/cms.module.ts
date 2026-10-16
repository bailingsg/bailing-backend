import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CmsController } from './cms.controller';
import { CmsService } from './cms.service';
import { ProductsModule } from './products/products.module';
import { BlogModule } from './blog/blog.module';
import { FactoryModule } from './factory/factory.module';
import { QualityModule } from './quality/quality.module';
import { ApplicationsModule } from './applications/applications.module';
import { RolesModule } from './roles/roles.module';
import { AccountsModule } from './accounts/accounts.module';
import { ContactsModule } from './contacts/contacts.module';
import { LeadDistributionModule } from './lead-distribution/lead-distribution.module';
import { SiteModule } from './site/site.module';
import { MediaModule } from '../media/media.module';

/**
 * CMS 模块（Phase 4.1 起步，4.2 纳入 Products，4.3 纳入 Media，4.4 纳入 Blog，
 * 4.5 纳入 Factory / Quality / Applications，4.6 纳入 Roles / Accounts / Contacts / LeadDistribution，
 * 4.7 纳入 Site（站点结构化内容 + 导航））。
 * 控制器级挂 JwtAuthGuard：本模块所有接口默认要求登录。
 */
@Module({
  imports: [
    PrismaModule,
    ProductsModule,
    MediaModule,
    BlogModule,
    FactoryModule,
    QualityModule,
    ApplicationsModule,
    RolesModule,
    AccountsModule,
    ContactsModule,
    LeadDistributionModule,
    SiteModule,
  ],
  controllers: [CmsController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule {}
