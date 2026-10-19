import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../rbac/audit-log.service';
import { RbacService } from '../rbac/rbac.service';
import type { ActorContext } from '../rbac/actor-context';
import type { AuthUser } from '../auth/auth.types';
import {
  CreateInventoryDto,
  ListInventoryQueryDto,
  UpdateInventoryDto,
} from './dto/inventory.dto';
import { generateInventoryCode, toInventoryQuantity } from './inventory.support';
import type { InventoryItemDto, Paginated } from './entities/inventory.entity';

const INVENTORY_INCLUDE = {
  creator: { select: { name: true, email: true } },
  order: { select: { id: true, code: true } },
} satisfies Prisma.InventoryItemInclude;

/** Decimal(14,3) → 干净字符串（去尾零、去小数点，不损失精度） */
function formatQuantity(quantity: Prisma.Decimal): string {
  const fixed = quantity.toFixed(3);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * 库存管理服务（Phase 5.3，单仓库）。
 *
 * 权限模型：
 *   · 管理员（isSuperAdmin）→ 查看/编辑/删除全部库存
 *   · 普通业务员 → 仅能管理自己创建的库存（createdById 恒为创建人，后端从会话确定）
 *
 * 订单关联：
 *   · orderId 可空；提供时后端校验订单存在且当前用户有权关联
 *     （订单归属业务员本人或管理员）；
 *   · 订单号从关联订单实时读取，不冗余副本；
 *   · 删除库存不影响订单（库存侧 FK Restrict，且删除动作只作用于库存行）。
 *
 * 数量精度：Decimal(14,3) 字符串化存取，杜绝二进制浮点误差。
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly audit: AuditLogService,
  ) {}

  async getActor(user: AuthUser): Promise<ActorContext> {
    const access = await this.rbac.resolveAccess(user.id);
    if (!access.isActive) throw new ForbiddenException('账号已停用');
    return {
      id: user.id,
      email: access.email,
      name: access.name,
      permissions: access.permissions,
      isSuperAdmin: access.isSuperAdmin,
    };
  }

  isAdmin(actor: ActorContext): boolean {
    return actor.isSuperAdmin;
  }

  /* ------------------------------ 列表 ------------------------------ */

  async list(actor: ActorContext, query: ListInventoryQueryDto): Promise<Paginated<InventoryItemDto>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const admin = this.isAdmin(actor);

    const where: Prisma.InventoryItemWhereInput = {};
    if (!admin) where.createdById = actor.id;
    if (query.code) where.code = query.code.trim();
    if (query.keyword) {
      where.OR = [
        { productName: { contains: query.keyword, mode: 'insensitive' } },
        { productDetail: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    if (query.location) where.location = { contains: query.location, mode: 'insensitive' };
    if (query.storedFrom || query.storedTo) {
      where.storedAt = {
        ...(query.storedFrom ? { gte: new Date(query.storedFrom) } : {}),
        ...(query.storedTo ? { lte: new Date(query.storedTo) } : {}),
      };
    }
    if (query.orderCode) {
      // 订单号筛选：先解析为订单 ID（权限过滤），无匹配订单 → 空结果（不泄漏他人订单存在性）
      const orderCode = query.orderCode.trim();
      const orders = await this.prisma.order.findMany({
        where: {
          code: orderCode,
          ...(admin ? {} : { salespersonId: actor.id }),
        },
        select: { id: true },
      });
      if (orders.length === 0) {
        return { items: [], total: 0, page, limit, totalPages: 1 };
      }
      where.orderId = { in: orders.map((o) => o.id) };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.inventoryItem.count({ where }),
      this.prisma.inventoryItem.findMany({
        where,
        include: INVENTORY_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      items: rows.map((row) => this.toDto(row)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /* ------------------------------ 详情 ------------------------------ */

  async detail(actor: ActorContext, id: string): Promise<InventoryItemDto> {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: INVENTORY_INCLUDE,
    });
    if (!item) throw new NotFoundException('库存记录不存在');
    if (!this.isAdmin(actor) && item.createdById !== actor.id) {
      throw new NotFoundException('库存记录不存在'); // 不泄漏他人库存存在性
    }
    return this.toDto(item);
  }

  /** 某订单关联的库存列表（供订单详情页展示） */
  async listByOrder(actor: ActorContext, orderId: string): Promise<InventoryItemDto[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { salespersonId: true },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (!this.isAdmin(actor) && order.salespersonId !== actor.id) {
      throw new NotFoundException('订单不存在');
    }
    const rows = await this.prisma.inventoryItem.findMany({
      where: { orderId },
      include: INVENTORY_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toDto(row));
  }

  /* ------------------------------ 新增 ------------------------------ */

  async create(actor: ActorContext, dto: CreateInventoryDto): Promise<InventoryItemDto> {
    await this.assertOrderAllowed(actor, dto.orderId);
    this.validateStoredAt(dto.storedAt);

    const quantity = toInventoryQuantity(dto.quantity);

    let created;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        created = await this.prisma.inventoryItem.create({
          data: {
            code: generateInventoryCode(),
            productName: dto.productName.trim(),
            productDetail: dto.productDetail.trim(),
            quantity: quantity.toFixed(3),
            unit: dto.unit,
            location: dto.location.trim(),
            storedAt: new Date(dto.storedAt),
            orderId: dto.orderId ?? null,
            createdById: actor.id,
          },
          include: INVENTORY_INCLUDE,
        });
        break;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          if (attempt === 4) throw new ConflictException('库存编号生成冲突，请重试');
          continue;
        }
        throw error;
      }
    }

    await this.audit.record({
      actor,
      action: 'inventory.create',
      targetType: 'inventory_item',
      targetId: created!.id,
      summary: `新增库存 ${created!.code}（${dto.productName.trim()}）`,
      diff: {
        quantity: quantity.toFixed(3),
        unit: dto.unit,
        orderId: dto.orderId ?? null,
      },
    });
    return this.detail(actor, created!.id);
  }

  /* ------------------------------ 编辑 ------------------------------ */

  async update(actor: ActorContext, id: string, dto: UpdateInventoryDto): Promise<InventoryItemDto> {
    const existing = await this.prisma.inventoryItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('库存记录不存在');
    if (!this.isAdmin(actor) && existing.createdById !== actor.id) {
      throw new ForbiddenException('只能编辑自己创建的库存记录');
    }
    await this.assertOrderAllowed(actor, dto.orderId);
    this.validateStoredAt(dto.storedAt);

    const quantity = toInventoryQuantity(dto.quantity);

    // 白名单字段更新（禁止客户端写入 code / createdById / id）
    await this.prisma.inventoryItem.update({
      where: { id },
      data: {
        productName: dto.productName.trim(),
        productDetail: dto.productDetail.trim(),
        quantity: quantity.toFixed(3),
        unit: dto.unit,
        location: dto.location.trim(),
        storedAt: new Date(dto.storedAt),
        orderId: dto.orderId ?? null,
      },
    });

    await this.audit.record({
      actor,
      action: 'inventory.update',
      targetType: 'inventory_item',
      targetId: id,
      summary: `编辑库存 ${existing.code}（${dto.productName.trim()}）`,
    });
    return this.detail(actor, id);
  }

  /* ------------------------------ 删除 ------------------------------ */

  /**
   * 删除库存（硬删 + 审计日志保留）。
   * 不级联删除订单：库存行上的 FK 为 RESTRICT，删除库存不会触及 orders 表；
   * orderId 置空语义由“删除整行”天然满足。
   */
  async remove(actor: ActorContext, id: string): Promise<{ id: string; code: string }> {
    const existing = await this.prisma.inventoryItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('库存记录不存在');
    if (!this.isAdmin(actor) && existing.createdById !== actor.id) {
      throw new ForbiddenException('只能删除自己创建的库存记录');
    }
    await this.prisma.inventoryItem.delete({ where: { id } });
    await this.audit.record({
      actor,
      action: 'inventory.delete',
      targetType: 'inventory_item',
      targetId: id,
      summary: `删除库存 ${existing.code}（${existing.productName}）`,
    });
    return { id, code: existing.code };
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 关联订单校验：存在 + 当前用户有权关联（本人订单或管理员） */
  private async assertOrderAllowed(actor: ActorContext, orderId?: string) {
    if (!orderId) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, code: true, salespersonId: true },
    });
    if (!order) throw new BadRequestException('关联订单不存在');
    if (!this.isAdmin(actor) && order.salespersonId !== actor.id) {
      throw new ForbiddenException('只能关联自己的订单');
    }
  }

  private validateStoredAt(storedAt: string) {
    const date = new Date(storedAt);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('存放日期不合法');
  }

  private toDto(item: {
    id: string;
    code: string;
    productName: string;
    productDetail: string;
    quantity: Prisma.Decimal;
    unit: string;
    location: string;
    storedAt: Date;
    orderId: string | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    creator: { name: string | null; email: string };
    order: { id: string; code: string } | null;
  }): InventoryItemDto {
    return {
      id: item.id,
      code: item.code,
      productName: item.productName,
      productDetail: item.productDetail,
      quantity: formatQuantity(item.quantity),
      unit: item.unit,
      location: item.location,
      storedAt: item.storedAt,
      orderId: item.orderId,
      orderCode: item.order?.code ?? null,
      createdById: item.createdById,
      creatorName: item.creator.name || item.creator.email,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
