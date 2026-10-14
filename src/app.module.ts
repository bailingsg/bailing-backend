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
import { CmsModule } from './modules/cms/cms.module';

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
    // Phase 4.1：CMS 接口（整体 JWT 保护）
    CmsModule,
  ],
})
export class AppModule {}
