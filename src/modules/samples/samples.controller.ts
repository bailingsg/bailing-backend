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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import {
  CreateSampleDto,
  CreateSampleRequestDto,
  DecideSampleRequestDto,
  GrantSamplesDto,
  ListSampleRequestsQueryDto,
  ListSamplesQueryDto,
  UpdateSampleDto,
} from './dto/samples.dto';
import { SamplesService } from './samples.service';

/**
 * 样品管理 CMS API（Phase 5.1）。
 *
 *   GET    /cms/samples                     列表（业务员仅见自己持有/被授权的样品）
 *   GET    /cms/samples/archive             出库归档历史（仅管理员）
 *   POST   /cms/samples                     新增样品（持有人 = 当前登录用户）
 *   GET    /cms/samples/:id                 详情（含授权名单与待审批申请）
 *   PATCH  /cms/samples/:id                 编辑（持有人或管理员）
 *   GET    /cms/samples/:id/logs            操作历史
 *   POST   /cms/samples/:id/grants          授权查看（仅管理员）
 *   DELETE /cms/samples/:id/grants/:userId  撤销授权（仅管理员）
 *   POST   /cms/samples/:id/requests        发起出库申请
 *   GET    /cms/samples/requests            申请列表（scope=pending|mine|all）
 *   POST   /cms/samples/requests/:id/withdraw   撤回申请（申请人本人）
 *   POST   /cms/samples/requests/:id/decide     审批（仅持有人）
 *
 * 注意路由顺序：/archive 与 /requests 为静态段，必须先于 :id 注册。
 */
@Controller('cms/samples')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SamplesController {
  constructor(private readonly samples: SamplesService) {}

  private actor(req: { user: AuthUser }) {
    return this.samples.getActor(req.user);
  }

  @Get()
  @RequirePermissions('samples.read')
  async list(@Query() query: ListSamplesQueryDto, @Req() req: { user: AuthUser }) {
    return this.samples.list(await this.actor(req), query);
  }

  @Get('archive')
  @RequirePermissions('samples.read')
  async archive(@Query() query: ListSamplesQueryDto, @Req() req: { user: AuthUser }) {
    return this.samples.listArchive(await this.actor(req), query);
  }

  @Get('requests')
  @RequirePermissions('samples.read')
  async listRequests(
    @Query() query: ListSampleRequestsQueryDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.samples.listRequests(await this.actor(req), query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('samples.create')
  async create(@Body() dto: CreateSampleDto, @Req() req: { user: AuthUser }) {
    return this.samples.create(await this.actor(req), dto);
  }

  @Get(':id')
  @RequirePermissions('samples.read')
  async detail(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    return this.samples.detail(await this.actor(req), id);
  }

  @Patch(':id')
  @RequirePermissions('samples.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSampleDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.samples.update(await this.actor(req), id, dto);
  }

  @Get(':id/logs')
  @RequirePermissions('samples.read')
  async logs(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    return this.samples.listLogs(await this.actor(req), id);
  }

  @Post(':id/grants')
  @RequirePermissions('samples.read')
  async grant(
    @Param('id') id: string,
    @Body() dto: GrantSamplesDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.samples.grant(await this.actor(req), id, dto);
  }

  @Delete(':id/grants/:userId')
  @RequirePermissions('samples.read')
  async revokeGrant(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() req: { user: AuthUser },
  ) {
    return this.samples.revokeGrant(await this.actor(req), id, userId);
  }

  @Post(':id/requests')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('samples.read')
  async createRequest(
    @Param('id') id: string,
    @Body() dto: CreateSampleRequestDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.samples.createRequest(await this.actor(req), id, dto);
  }

  @Post('requests/:requestId/withdraw')
  @RequirePermissions('samples.read')
  async withdraw(
    @Param('requestId') requestId: string,
    @Req() req: { user: AuthUser },
  ) {
    return this.samples.withdrawRequest(await this.actor(req), requestId);
  }

  @Post('requests/:requestId/decide')
  @RequirePermissions('samples.read')
  async decide(
    @Param('requestId') requestId: string,
    @Body() dto: DecideSampleRequestDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.samples.decideRequest(await this.actor(req), requestId, dto);
  }
}
