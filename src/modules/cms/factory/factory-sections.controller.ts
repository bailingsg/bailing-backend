import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  CreateFactorySectionDto,
  UpdateFactorySectionDto,
} from './dto/factory-section.dto';
import { ListFactorySectionsQueryDto } from './dto/list-factory-sections-query.dto';
import { FactorySectionsService } from './factory-sections.service';
import type {
  FactoryExhibitionDto,
  FactorySectionDetailDto,
  PaginatedFactorySectionsDto,
} from './entities/factory.entity';

/**
 * 工厂实力 CMS API（Phase 4.5，控制器级 JwtAuthGuard，全部要求登录）。
 *
 *   GET    /api/v1/cms/factory                    列表（page/limit/keyword/sectionType/status）
 *   POST   /api/v1/cms/factory                    创建
 *   GET    /api/v1/cms/factory/:id                详情
 *   PATCH  /api/v1/cms/factory/:id                更新
 *   DELETE /api/v1/cms/factory/:id                删除（仅解除关联，不删媒体）
 *   GET    /api/v1/cms/factory/:id/exhibitions    该分区下的参展记录
 *
 * 未来权限扩展：本控制器仅做「登录校验」，不写死管理员角色。
 * 引入 RBAC 时在此挂 `@RequirePermission('FACTORY_READ' | 'FACTORY_CREATE' | ...)`，
 * 服务层与数据层无需改动。
 */
@Controller('cms/factory')
@UseGuards(JwtAuthGuard)
export class FactorySectionsController {
  constructor(private readonly sectionsService: FactorySectionsService) {}

  @Get()
  list(@Query() query: ListFactorySectionsQueryDto): Promise<PaginatedFactorySectionsDto> {
    return this.sectionsService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateFactorySectionDto): Promise<FactorySectionDetailDto> {
    return this.sectionsService.create(dto);
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<FactorySectionDetailDto> {
    return this.sectionsService.findById(id);
  }

  @Get(':id/exhibitions')
  listExhibitions(@Param('id') id: string): Promise<FactoryExhibitionDto[]> {
    return this.sectionsService.listExhibitions(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFactorySectionDto,
  ): Promise<FactorySectionDetailDto> {
    return this.sectionsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.sectionsService.remove(id);
  }
}
