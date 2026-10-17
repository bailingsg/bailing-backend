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
  CreateApplicationDto,
  UpdateApplicationDto,
} from './dto/application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { ApplicationsService } from './applications.service';
import { draftVersionFrom } from '../publishing/publishing.engine';
import type {
  ApplicationDetailDto,
  PaginatedApplicationsDto,
} from './entities/application.entity';

/** 已鉴权请求（JwtAuthGuard 保证 user 存在） */
interface AuthedRequest {
  user: { id: string };
  headers: Record<string, unknown>;
}

/**
 * 产品应用场景 CMS API（Phase 4.5，控制器级 JwtAuthGuard，全部要求登录）。
 *
 *   GET    /api/v1/cms/applications      列表（page/limit/keyword/status/featured）
 *   POST   /api/v1/cms/applications      创建
 *   GET    /api/v1/cms/applications/:id  详情
 *   PATCH  /api/v1/cms/applications/:id  更新（products 数组 = 整体替换关联）
 *   DELETE /api/v1/cms/applications/:id  删除（仅解除产品关联，不删产品）
 *
 * 未来权限扩展：本控制器仅做「登录校验」，不写死管理员角色。
 * 引入 RBAC 时在此挂 `@RequirePermission('APPLICATION_READ' | ...)`。
 */
@Controller('cms/applications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Get()
  @RequirePermissions('applications.read')
  list(@Query() query: ListApplicationsQueryDto): Promise<PaginatedApplicationsDto> {
    return this.applicationsService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('applications.create')
  create(@Body() dto: CreateApplicationDto): Promise<ApplicationDetailDto> {
    return this.applicationsService.create(dto);
  }

  @Get(':id')
  @RequirePermissions('applications.read')
  detail(@Param('id') id: string): Promise<ApplicationDetailDto> {
    return this.applicationsService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('applications.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
    @Req() request: AuthedRequest,
  ) {
    // Phase 1：已发布过的场景，普通保存只写编辑稿，绝不覆盖线上版本
    const state = await this.applicationsService.publishState(id);
    if (state.publishedVersion > 0 || state.hasDraft) {
      const draft = await this.applicationsService.saveDraft(
        id,
        dto,
        request.user?.id ?? null,
        draftVersionFrom(request.headers),
      );
      const current = await this.applicationsService.findById(id);
      return { ...current, hasUnpublishedChanges: true, draftVersion: draft.draftVersion };
    }
    return this.applicationsService.update(id, dto);
  }

  /** 发布当前编辑稿（独立权限 + 服务端完整性校验） */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('applications.publish')
  publish(@Param('id') id: string, @Req() request: AuthedRequest): Promise<ApplicationDetailDto> {
    return this.applicationsService.publish(id, request.user?.id ?? null);
  }

  /** 取消发布（保留内容与历史） */
  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('applications.unpublish')
  unpublish(@Param('id') id: string): Promise<ApplicationDetailDto> {
    return this.applicationsService.unpublish(id);
  }

  /** 预览（线上版本 + 编辑稿，仅后台授权访问） */
  @Get(':id/preview')
  @RequirePermissions('applications.read')
  preview(@Param('id') id: string) {
    return this.applicationsService.preview(id);
  }

  /** 发布历史 */
  @Get(':id/revisions')
  @RequirePermissions('applications.read')
  revisions(@Param('id') id: string) {
    return this.applicationsService.revisions(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('applications.delete')
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.applicationsService.remove(id);
  }
}
