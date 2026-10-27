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
 */
@Controller('rfq')
export class RfqController {
  constructor(private readonly rfqService: RfqService) {}

  /** 创建询盘（公开接口） */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateRfqDto, @Req() request: Request) {
    return this.rfqService.create(dto, {
      sourceIp: resolveClientIp(request),
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
  }

  /** 后台：询盘列表 */
  @Get()
  @UseGuards(RfqAuthGuard)
  @RequirePermissions('rfq.read')
  list(@Query() query: ListRfqQueryDto) {
    return this.rfqService.list(query);
  }

  /** 后台：询盘详情 */
  @Get(':id')
  @UseGuards(RfqAuthGuard)
  @RequirePermissions('rfq.read')
  detail(@Param('id') id: string) {
    return this.rfqService.findById(id);
  }

  /** 后台：状态更新 */
  @Patch(':id/status')
  @UseGuards(RfqAuthGuard)
  @RequirePermissions('rfq.update')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateRfqStatusDto) {
    return this.rfqService.updateStatus(id, dto.status);
  }

  /** 后台：人工补发询盘通知邮件（走与自动首发相同的链路与重试） */
  @Post(':id/notify')
  @UseGuards(RfqAuthGuard)
  @RequirePermissions('rfq.update')
  resendNotification(@Param('id') id: string) {
    return this.rfqService.resendNotification(id);
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
