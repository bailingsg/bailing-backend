import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CmsService } from './cms.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RbacService } from '../rbac/rbac.service';
import { toActorContext, type ActorContext } from '../rbac/actor-context';
import type { AuthUser } from '../auth/auth.types';
import type { CmsStatsDto } from './cms.dto';

/**
 * CMS 后台接口（Phase 4.1 起所有新增 CMS 接口必须 JWT 保护；
 * Phase 4.6 起同时要求功能权限）。
 *
 * 当前仅开放：
 *   GET /api/v1/cms/stats   Dashboard 真实统计（询盘 / 产品 / 分类 / 文章）
 *
 * 询盘口径按操作人隔离（2026-10-28）：
 *   · 超级管理员 → 全局询盘计数
 *   · 业务 / 销售账号 → 仅「分配给本人」的询盘计数
 * 因此本接口必须把操作人上下文传给 Service，否则业务账号会看到全局数字。
 *
 * Phase 0 起 RFQ 后台接口已并入 RBAC（rfq.read / rfq.update），
 * 由 RfqAuthGuard 统一鉴权，不再使用未配置即放行的共享密钥逻辑。
 */
@Controller('cms')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CmsController {
  constructor(
    private readonly cmsService: CmsService,
    private readonly rbac: RbacService,
  ) {}

  /** Dashboard 统计卡片数据源（询盘计数按操作人隔离） */
  @Get('stats')
  @RequirePermissions('dashboard.read')
  async stats(@Req() request: Request & { user: AuthUser }): Promise<CmsStatsDto> {
    return this.cmsService.getStats(await this.actorOf(request));
  }

  /** 当前操作人（JWT 通道由 JwtAuthGuard 注入 request.user） */
  private async actorOf(request: Request & { user: AuthUser }): Promise<ActorContext> {
    const access = await this.rbac.resolveAccess(request.user.id);
    return toActorContext(request.user, access);
  }
}
