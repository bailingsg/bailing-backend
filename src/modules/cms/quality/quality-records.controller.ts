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
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import {
  CreateQualityRecordDto,
  UpdateQualityRecordDto,
} from './dto/quality-record.dto';
import { ListQualityRecordsQueryDto } from './dto/list-quality-records-query.dto';
import { QualityRecordsService } from './quality-records.service';
import type {
  PaginatedQualityRecordsDto,
  QualityRecordDetailDto,
} from './entities/quality.entity';

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
  update(
    @Param('id') id: string,
    @Body() dto: UpdateQualityRecordDto,
  ): Promise<QualityRecordDetailDto> {
    return this.recordsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('quality.delete')
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.recordsService.remove(id);
  }
}
