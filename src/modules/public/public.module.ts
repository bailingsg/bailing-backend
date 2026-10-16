import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ContactsModule } from '../cms/contacts/contacts.module';
import { PublicFactoryController } from './public-factory.controller';
import { PublicFactoryService } from './public-factory.service';
import { PublicQualityController } from './public-quality.controller';
import { PublicQualityService } from './public-quality.service';
import { PublicApplicationsController } from './public-applications.controller';
import { PublicApplicationsService } from './public-applications.service';
import { PublicContactsController } from './public-contacts.controller';

/**
 * 公开只读 API 模块（Phase 4.5，Phase 4.6 增加员工联系方式）。
 *
 * 全部接口**不挂 JwtAuthGuard**（公开站免登录访问），
 * 但服务层强制过滤 status = PUBLISHED / showOnSite，只暴露已发布内容。
 *
 * 对外路径前缀：/api/v1/public/*
 */
@Module({
  imports: [PrismaModule, ContactsModule],
  controllers: [
    PublicFactoryController,
    PublicQualityController,
    PublicApplicationsController,
    PublicContactsController,
  ],
  providers: [PublicFactoryService, PublicQualityService, PublicApplicationsService],
})
export class PublicModule {}
