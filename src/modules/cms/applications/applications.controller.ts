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
  CreateApplicationDto,
  UpdateApplicationDto,
} from './dto/application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { ApplicationsService } from './applications.service';
import type {
  ApplicationDetailDto,
  PaginatedApplicationsDto,
} from './entities/application.entity';

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
@UseGuards(JwtAuthGuard)
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Get()
  list(@Query() query: ListApplicationsQueryDto): Promise<PaginatedApplicationsDto> {
    return this.applicationsService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateApplicationDto): Promise<ApplicationDetailDto> {
    return this.applicationsService.create(dto);
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<ApplicationDetailDto> {
    return this.applicationsService.findById(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
  ): Promise<ApplicationDetailDto> {
    return this.applicationsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.applicationsService.remove(id);
  }
}
