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
  ],
})
export class AppModule {}
