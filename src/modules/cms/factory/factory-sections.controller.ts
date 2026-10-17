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
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import {
  CreateFactorySectionDto,
  UpdateFactorySectionDto,
} from './dto/factory-section.dto';
import { ListFactorySectionsQueryDto } from './dto/list-factory-sections-query.dto';
import { FactorySectionsService } from './factory-sections.service';
import { draftVersionFrom } from '../publishing/publishing.engine';
import type {
  FactoryExhibitionDto,
  FactorySectionDetailDto,
  PaginatedFactorySectionsDto,
} from './entities/factory.entity';

/** 已鉴权请求（JwtAuthGuard 保证 user 存在） */
interface AuthedRequest {
  user: { id: string };
  headers: Record<string, unknown>;
}

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
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FactorySectionsController {
  constructor(private readonly sectionsService: FactorySectionsService) {}

  @Get()
  @RequirePermissions('factory.read')
  list(@Query() query: ListFactorySectionsQueryDto): Promise<PaginatedFactorySectionsDto> {
    return this.sectionsService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('factory.create')
  create(@Body() dto: CreateFactorySectionDto): Promise<FactorySectionDetailDto> {
    return this.sectionsService.create(dto);
  }

  @Get(':id')
  @RequirePermissions('factory.read')
  detail(@Param('id') id: string): Promise<FactorySectionDetailDto> {
    return this.sectionsService.findById(id);
  }

  @Get(':id/exhibitions')
  @RequirePermissions('factory.read')
  listExhibitions(@Param('id') id: string): Promise<FactoryExhibitionDto[]> {
    return this.sectionsService.listExhibitions(id);
  }

  @Patch(':id')
  @RequirePermissions('factory.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFactorySectionDto,
    @Req() request: AuthedRequest,
  ) {
    // Phase 1：已发布过的分区，普通保存只写编辑稿，绝不覆盖线上版本
    const state = await this.sectionsService.publishState(id);
    if (state.publishedVersion > 0 || state.hasDraft) {
      const draft = await this.sectionsService.saveDraft(
        id,
        dto,
        request.user?.id ?? null,
        draftVersionFrom(request.headers),
      );
      const current = await this.sectionsService.findById(id);
      return { ...current, hasUnpublishedChanges: true, draftVersion: draft.draftVersion };
    }
    return this.sectionsService.update(id, dto);
  }

  /** 发布当前编辑稿（独立权限 + 服务端完整性校验） */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory.publish')
  publish(@Param('id') id: string, @Req() request: AuthedRequest): Promise<FactorySectionDetailDto> {
    return this.sectionsService.publish(id, request.user?.id ?? null);
  }

  /** 取消发布（保留内容与历史） */
  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory.unpublish')
  unpublish(@Param('id') id: string): Promise<FactorySectionDetailDto> {
    return this.sectionsService.unpublish(id);
  }

  /** 预览（线上版本 + 编辑稿，仅后台授权访问） */
  @Get(':id/preview')
  @RequirePermissions('factory.read')
  preview(@Param('id') id: string) {
    return this.sectionsService.preview(id);
  }

  /** 发布历史 */
  @Get(':id/revisions')
  @RequirePermissions('factory.read')
  revisions(@Param('id') id: string) {
    return this.sectionsService.revisions(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory.delete')
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.sectionsService.remove(id);
  }
}
