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
  CreateQualityRecordDto,
  UpdateQualityRecordDto,
} from './dto/quality-record.dto';
import { ListQualityRecordsQueryDto } from './dto/list-quality-records-query.dto';
import { QualityRecordsService } from './quality-records.service';
import { draftVersionFrom } from '../publishing/publishing.engine';
import type {
  PaginatedQualityRecordsDto,
  QualityRecordDetailDto,
} from './entities/quality.entity';

/** 已鉴权请求（JwtAuthGuard 保证 user 存在） */
interface AuthedRequest {
  user: { id: string };
  headers: Record<string, unknown>;
}

/**
 * 质量体系 CMS API（Phase 4.5，控制器级 JwtAuthGuard，全部要求登录）。
 *
 *   GET    /api/v1/cms/quality      列表（page/limit/keyword/recordType/status）
 *   POST   /api/v1/cms/quality      创建
 *   GET    /api/v1/cms/quality/:id  详情
 *   PATCH  /api/v1/cms/quality/:id  更新
 *   DELETE /api/v1/cms/quality/:id  删除（仅解除关联，不删媒体）
 *
 * 未来权限扩展：本控制器仅做「登录校验」，不写死管理员角色。
 * 引入 RBAC 时在此挂 `@RequirePermission('QUALITY_READ' | 'QUALITY_WRITE' | ...)`。
 */
@Controller('cms/quality')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class QualityRecordsController {
  constructor(private readonly recordsService: QualityRecordsService) {}

  @Get()
  @RequirePermissions('quality.read')
  list(@Query() query: ListQualityRecordsQueryDto): Promise<PaginatedQualityRecordsDto> {
    return this.recordsService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('quality.create')
  create(@Body() dto: CreateQualityRecordDto): Promise<QualityRecordDetailDto> {
    return this.recordsService.create(dto);
  }

  @Get(':id')
  @RequirePermissions('quality.read')
  detail(@Param('id') id: string): Promise<QualityRecordDetailDto> {
    return this.recordsService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('quality.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateQualityRecordDto,
    @Req() request: AuthedRequest,
  ) {
    // Phase 1：已发布过的记录，普通保存只写编辑稿，绝不覆盖线上版本
    const state = await this.recordsService.publishState(id);
    if (state.publishedVersion > 0 || state.hasDraft) {
      const draft = await this.recordsService.saveDraft(
        id,
        dto,
        request.user?.id ?? null,
        draftVersionFrom(request.headers),
      );
      const current = await this.recordsService.findById(id);
      return { ...current, hasUnpublishedChanges: true, draftVersion: draft.draftVersion };
    }
    return this.recordsService.update(id, dto);
  }

  /** 发布当前编辑稿（独立权限 + 服务端完整性校验） */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('quality.publish')
  publish(@Param('id') id: string, @Req() request: AuthedRequest): Promise<QualityRecordDetailDto> {
    return this.recordsService.publish(id, request.user?.id ?? null);
  }

  /** 取消发布（保留内容与历史） */
  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('quality.unpublish')
  unpublish(@Param('id') id: string): Promise<QualityRecordDetailDto> {
    return this.recordsService.unpublish(id);
  }

  /** 预览（线上版本 + 编辑稿，仅后台授权访问） */
  @Get(':id/preview')
  @RequirePermissions('quality.read')
  preview(@Param('id') id: string) {
    return this.recordsService.preview(id);
  }

  /** 发布历史 */
  @Get(':id/revisions')
  @RequirePermissions('quality.read')
  revisions(@Param('id') id: string) {
    return this.recordsService.revisions(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('quality.delete')
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.recordsService.remove(id);
  }
}
