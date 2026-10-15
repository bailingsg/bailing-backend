import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicFactoryController } from './public-factory.controller';
import { PublicFactoryService } from './public-factory.service';
import { PublicQualityController } from './public-quality.controller';
import { PublicQualityService } from './public-quality.service';
import { PublicApplicationsController } from './public-applications.controller';
import { PublicApplicationsService } from './public-applications.service';

/**
 * 公开只读 API 模块（Phase 4.5）。
 *
 * 全部接口**不挂 JwtAuthGuard**（公开站免登录访问），
 * 但服务层强制过滤 status = PUBLISHED，只暴露已发布内容。
 *
 * 对外路径前缀：/api/v1/public/*
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    PublicFactoryController,
    PublicQualityController,
    PublicApplicationsController,
  ],
  providers: [PublicFactoryService, PublicQualityService, PublicApplicationsService],
})
export class PublicModule {}
