import {
  BadRequestException,
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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CreateOrderDto, ListOrdersQueryDto, UpdateOrderDto } from './dto/orders.dto';
import { MAX_ORDER_ATTACHMENT_SIZE } from './order-file.service';
import { OrdersService } from './orders.service';

const FILE_FIELD = 'file';

/**
 * 订单管理 CMS API（Phase 5.2）。
 *
 *   POST /cms/orders/uploads                 上传订单照片（临时态，multipart 字段 file）
 *   GET  /cms/orders                         列表（业务员仅自己的；管理员全部）
 *   POST /cms/orders                         新建订单（业务员 = 当前登录用户）
 *   GET  /cms/orders/:id                     详情
 *   PATCH /cms/orders/:id                    编辑（含附件增删）
 *   GET  /cms/orders/:id/attachments/:attId/file   附件文件流（鉴权后输出）
 */
@Controller('cms/orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  private actor(req: { user: AuthUser }) {
    return this.orders.getActor(req.user);
  }

  /** 上传订单照片（单张；前端逐张上传并展示进度） */
  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor(FILE_FIELD, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_ORDER_ATTACHMENT_SIZE, files: 1 },
    }),
  )
  @RequirePermissions('orders.create')
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: { user: AuthUser },
  ) {
    if (!file) throw new BadRequestException('请上传文件（字段名 file）');
    return this.orders.uploadAttachment(await this.actor(req), file);
  }

  @Get()
  @RequirePermissions('orders.read')
  async list(@Query() query: ListOrdersQueryDto, @Req() req: { user: AuthUser }) {
    return this.orders.list(await this.actor(req), query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('orders.create')
  async create(@Body() dto: CreateOrderDto, @Req() req: { user: AuthUser }) {
    return this.orders.create(await this.actor(req), dto);
  }

  @Get(':id')
  @RequirePermissions('orders.read')
  async detail(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    return this.orders.detail(await this.actor(req), id);
  }

  @Patch(':id')
  @RequirePermissions('orders.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.orders.update(await this.actor(req), id, dto);
  }

  /**
   * 附件文件流：唯一的订单图片访问通道。
   * 不落静态目录、不返回 URL 下载地址——权限校验通过后才读文件输出。
   */
  @Get(':id/attachments/:attachmentId/file')
  @RequirePermissions('orders.read')
  async attachmentFile(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: { user: AuthUser },
    @Res() res: Response,
  ) {
    const result = await this.orders.readAttachmentFile(
      await this.actor(req),
      id,
      attachmentId,
    );
    res.setHeader('Content-Type', result.mime);
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(result.data);
  }
}
