import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './modules/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { ProductsModule } from './modules/products/products.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { RfqModule } from './modules/rfq/rfq.module';
import { AuthModule } from './modules/auth/auth.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { CmsModule } from './modules/cms/cms.module';
import { PublicModule } from './modules/public/public.module';
import { RevalidationModule } from './modules/revalidation/revalidation.module';
import { SeoModule } from './modules/seo/seo.module';
import { MailModule } from './modules/mail/mail.module';
import { SamplesModule } from './modules/samples/samples.module';
import { OrdersModule } from './modules/orders/orders.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { VisitorModule } from './modules/visitor/visitor.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env'],
      validate: validateEnv,
    }),
    PrismaModule,
    HealthModule,
    ProductsModule,
    CategoriesModule,
    RfqModule,
    // Phase 4.1：管理员认证（login / me / JWT Guard）
    AuthModule,
    // Phase 4.6：RBAC（权限注册表 / PermissionsGuard / 提权防护 / 审计日志），@Global
    RbacModule,
    // Phase 4.1：CMS 接口（整体 JWT 保护）
    CmsModule,
    // Phase 4.5：公开只读 API（工厂 / 质量 / 应用场景，仅返回已发布内容）
    PublicModule,
    // Phase 4.8：前台缓存失效（CMS 变更 → 通知 bailing-ui revalidate），@Global
    RevalidationModule,
    // Phase 5.0：全站 SEO 基础设施（档案 / 设置 / 重定向 / 审计 / sitemap / robots / 公开解析）
    SeoModule,
    // 询盘邮件通知（SMTP，@Global）：访客提交询盘后把内容邮件发给承接业务员
    MailModule,
    // Phase 5.1：样品管理（单仓库 / 持有人 / 出库申请审批 / 授权）
    SamplesModule,
    // Phase 5.2：订单管理（业务员订单 / 附件与媒体库隔离）
    OrdersModule,
    // Phase 5.3：库存管理（单仓库 / 可关联订单 / 订单号手动填写）
    InventoryModule,
    // 访客统计（匿名流量旁路）：公开 track 上报 + 后台聚合与明细（见 modules/visitor/visitor.module.ts）
    VisitorModule,
  ],
})
export class AppModule {}
