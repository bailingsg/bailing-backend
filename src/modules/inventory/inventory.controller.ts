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
  CreateInventoryDto,
  ListInventoryQueryDto,
  UpdateInventoryDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

/**
 * 库存管理 CMS API（Phase 5.3，单仓库）。
 *
 *   GET    /cms/inventory               列表（业务员仅自己的；管理员全部）
 *   POST   /cms/inventory               新增库存（创建人 = 当前登录用户）
 *   GET    /cms/inventory/:id           详情
 *   PATCH  /cms/inventory/:id           编辑（字段白名单，订单号只读）
 *   DELETE /cms/inventory/:id           删除（不级联删除订单）
 *   GET    /cms/inventory/orders/:orderId   某订单关联的库存（订单详情页）
 */
@Controller('cms/inventory')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  private actor(req: { user: AuthUser }) {
    return this.inventory.getActor(req.user);
  }

  /** 某订单关联的库存（静态路由先于 :id） */
  @Get('orders/:orderId')
  @RequirePermissions('inventory.read')
  async listByOrder(@Param('orderId') orderId: string, @Req() req: { user: AuthUser }) {
    return this.inventory.listByOrder(await this.actor(req), orderId);
  }

  @Get()
  @RequirePermissions('inventory.read')
  async list(@Query() query: ListInventoryQueryDto, @Req() req: { user: AuthUser }) {
    return this.inventory.list(await this.actor(req), query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('inventory.create')
  async create(@Body() dto: CreateInventoryDto, @Req() req: { user: AuthUser }) {
    return this.inventory.create(await this.actor(req), dto);
  }

  @Get(':id')
  @RequirePermissions('inventory.read')
  async detail(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    return this.inventory.detail(await this.actor(req), id);
  }

  @Patch(':id')
  @RequirePermissions('inventory.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateInventoryDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.inventory.update(await this.actor(req), id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.delete')
  async remove(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    return this.inventory.remove(await this.actor(req), id);
  }
}
