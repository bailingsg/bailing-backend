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
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RbacService } from '../rbac/rbac.service';
import { toActorContext, type ActorContext } from '../rbac/actor-context';
import type { AuthUser } from '../auth/auth.types';
import { RfqAuthGuard } from './rfq-auth.guard';
import { CreateRfqDto } from './dto/create-rfq.dto';
import { ListRfqQueryDto } from './dto/list-rfq-query.dto';
import { UpdateRfqStatusDto } from './dto/update-rfq-status.dto';
import { RfqService } from './rfq.service';

/**
 * RFQ 询盘 API。
 *
 * 公开：
 *   POST /api/v1/rfq                 访客提交询盘（201 / 400）
 *
 * 后台（RfqAuthGuard：JWT + RBAC 主通道 / X-Admin-Token 兼容通道，均 fail-closed）：
 *   GET   /api/v1/rfq                列表   → rfq.read
 *   GET   /api/v1/rfq/:id            详情   → rfq.read
 *   PATCH /api/v1/rfq/:id/status     状态流转 → rfq.update
 *   POST  /api/v1/rfq/:id/notify     补发通知邮件 → rfq.update
 *
 * 数据隔离（2026-10-28）：
 *   · JWT 通道下的**非超管账号**（业务 / 销售）只能看到「分配给本人」的询盘，
 *     列表、详情、状态流转、补发通知四个动作统一按承接人过滤；
 *     越权访问他人询盘一律返回 404（不泄漏存在性）。
 *   · 超级管理员看全部。
 *   · X-Admin-Token 兼容通道是「服务身份」，无自然人归属，保持全局可见（与改造前一致），
 *     供运维脚本 / 旧集成使用。
 */
@Controller('rfq')
export class RfqController {
  constructor(
    private readonly rfqService: RfqService,
    private readonly rbac: RbacService,
  ) {}

  /**
   * 当前操作人上下文。
   *
   * JWT 通道由 RfqAuthGuard 注入 request.user → 解析 RBAC 得到 ActorContext；
   * 兼容通道（X-Admin-Token）没有自然人，返回 undefined，Service 层据此不做按人过滤。
   */
  private async actorOf(
    request: Request & { user?: AuthUser },
  ): Promise<ActorContext | undefined> {
    if (!request.user) return undefined;
    const access = await this.rbac.resolveAccess(request.user.id);
    return toActorContext(request.user, access);
  }

  /** 创建询盘（公开接口） */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateRfqDto, @Req() request: Request) {
    return this.rfqService.create(dto, {
      sourceIp: resolveClientIp(request),
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
  }

  /** 后台：询盘列表（业务账号仅返回分配给本人的） */
  @Get()
  @UseGuards(RfqAuthGuard)
  @RequirePermissions('rfq.read')
  async list(@Query() query: ListRfqQueryDto, @Req() request: Request & { user?: AuthUser }) {
    return this.rfqService.list(query, await this.actorOf(request));
  }

  /** 后台：询盘详情（业务账号仅限本人的询盘） */
  @Get(':id')
  @UseGuards(RfqAuthGuard)
  @RequirePermissions('rfq.read')
  async detail(@Param('id') id: string, @Req() request: Request & { user?: AuthUser }) {
    return this.rfqService.findById(id, await this.actorOf(request));
  }

  /** 后台：状态更新（业务账号仅限本人的询盘） */
  @Patch(':id/status')
  @UseGuards(RfqAuthGuard)
  @RequirePermissions('rfq.update')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateRfqStatusDto,
    @Req() request: Request & { user?: AuthUser },
  ) {
    return this.rfqService.updateStatus(id, dto.status, await this.actorOf(request));
  }

  /** 后台：人工补发询盘通知邮件（走与自动首发相同的链路与重试；业务账号仅限本人的询盘） */
  @Post(':id/notify')
  @UseGuards(RfqAuthGuard)
  @RequirePermissions('rfq.update')
  async resendNotification(
    @Param('id') id: string,
    @Req() request: Request & { user?: AuthUser },
  ) {
    return this.rfqService.resendNotification(id, await this.actorOf(request));
  }
}

/** 解析真实客户端 IP（经代理时取 X-Forwarded-For 首个地址） */
function resolveClientIp(request: Request): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip ?? null;
}
