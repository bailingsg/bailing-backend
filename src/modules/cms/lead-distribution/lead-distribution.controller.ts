import {
  Body,
  Controller,
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
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { RbacService } from '../../rbac/rbac.service';
import { toActorContext, type ActorContext } from '../../rbac/actor-context';
import type { AuthUser } from '../../auth/auth.types';
import { LeadDistributionService } from './lead-distribution.service';
import {
  ClosePlanDto,
  CreatePlanDto,
  ListAssignmentsQueryDto,
  ListPlanLogsQueryDto,
  UpdatePlanDto,
} from './dto/lead-distribution.dto';
import type {
  CreatePlanResultDto,
  EligibleAssigneeDto,
  LeadDistributionStateDto,
  PaginatedAssignmentsDto,
  PlanDto,
  PlanLogDto,
} from './entities/lead-distribution.entity';

/**
 * 询盘分配 CMS API（Phase 4.6）。
 *
 *   GET    /api/v1/cms/lead-distribution                 页面主状态（lead_distribution.read）
 *   GET    /api/v1/cms/lead-distribution/assignments      分配历史分页（lead_distribution.read）
 *   GET    /api/v1/cms/lead-distribution/plans/eligible   可分配员工预检（lead_distribution.read）
 *   GET    /api/v1/cms/lead-distribution/plans/:id        计划详情（lead_distribution.read）
 *   GET    /api/v1/cms/lead-distribution/plans/:id/logs   计划操作历史（lead_distribution.read）
 *   POST   /api/v1/cms/lead-distribution/plans            创建倾斜计划（lead_distribution.manage）
 *   PATCH  /api/v1/cms/lead-distribution/plans/:id        调整计划（lead_distribution.manage）
 *   POST   /api/v1/cms/lead-distribution/plans/:id/close  手动关闭（lead_distribution.close）
 *   POST   /api/v1/cms/lead-distribution/plans/:id/resume 手动恢复（lead_distribution.manage）
 *
 * 全部接口要求登录（JwtAuthGuard）+ 对应权限（PermissionsGuard，实时查库）。
 * 分配动作本身由 RFQ 创建入口自动触发，不提供手工分配接口（避免绕过轮询公平性）。
 */
@Controller('cms/lead-distribution')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeadDistributionController {
  constructor(
    private readonly leadDistributionService: LeadDistributionService,
    private readonly rbac: RbacService,
  ) {}

  private async actorOf(request: Request & { user: AuthUser }): Promise<ActorContext> {
    const access = await this.rbac.resolveAccess(request.user.id);
    return toActorContext(request.user, access);
  }

  /** 页面主状态：模式 / 队列 / 下一位承接人 / 当前计划 / 最近分配 / 趋势 */
  @Get()
  @RequirePermissions('lead_distribution.read')
  state(): Promise<LeadDistributionStateDto> {
    return this.leadDistributionService.getState();
  }

  /** 分配历史（分页 + 按承接人 / 来源筛选） */
  @Get('assignments')
  @RequirePermissions('lead_distribution.read')
  assignments(@Query() query: ListAssignmentsQueryDto): Promise<PaginatedAssignmentsDto> {
    return this.leadDistributionService.listAssignments(query);
  }

  /** 可分配员工预检（创建计划弹窗的数据源） */
  @Get('plans/eligible')
  @RequirePermissions('lead_distribution.read')
  eligible(): Promise<EligibleAssigneeDto[]> {
    return this.leadDistributionService.listEligibleAssignees();
  }

  /** 计划详情（弹窗数据源；进度为真实计数） */
  @Get('plans/:id')
  @RequirePermissions('lead_distribution.read')
  plan(@Param('id') id: string): Promise<PlanDto> {
    return this.leadDistributionService.getPlan(id);
  }

  /** 计划操作历史 */
  @Get('plans/:id/logs')
  @RequirePermissions('lead_distribution.read')
  logs(
    @Param('id') id: string,
    @Query() query: ListPlanLogsQueryDto,
  ): Promise<PlanLogDto[]> {
    return this.leadDistributionService.listLogs(id, query);
  }

  /** 创建倾斜计划 */
  @Post('plans')
  @RequirePermissions('lead_distribution.manage')
  createPlan(
    @Body() dto: CreatePlanDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<CreatePlanResultDto> {
    return this.actorOf(request).then((actor) =>
      this.leadDistributionService.createPlan(dto, actor),
    );
  }

  /** 调整进行中计划的员工与目标数量 */
  @Patch('plans/:id')
  @RequirePermissions('lead_distribution.manage')
  updatePlan(
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<PlanDto> {
    return this.actorOf(request).then((actor) =>
      this.leadDistributionService.updatePlan(id, dto, actor),
    );
  }

  /** 手动关闭计划：立即恢复正常轮询 */
  @Post('plans/:id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('lead_distribution.close')
  closePlan(
    @Param('id') id: string,
    @Body() dto: ClosePlanDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<PlanDto> {
    return this.actorOf(request).then((actor) =>
      this.leadDistributionService.closePlan(id, dto, actor),
    );
  }

  /** 手动恢复已关闭的计划（不必等冷却结束） */
  @Post('plans/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('lead_distribution.manage')
  resumePlan(
    @Param('id') id: string,
    @Req() request: Request & { user: AuthUser },
  ): Promise<PlanDto> {
    return this.actorOf(request).then((actor) =>
      this.leadDistributionService.resumePlan(id, actor),
    );
  }
}
