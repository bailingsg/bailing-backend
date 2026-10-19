import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderCurrency, Prisma } from '@prisma/client';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../rbac/audit-log.service';
import { RbacService } from '../rbac/rbac.service';
import type { ActorContext } from '../rbac/actor-context';
import type { AuthUser } from '../auth/auth.types';
import { CreateOrderDto, ListOrdersQueryDto, UpdateOrderDto } from './dto/orders.dto';
import type { OrderInventoryDto } from './dto/order-inventory.dto';
import { generateInventoryCode, toInventoryQuantity } from '../inventory/inventory.support';
import { OrderFileService, ORDER_ATTACHMENT_MIME } from './order-file.service';
import type { OrderAttachmentDto, OrderDto, Paginated } from './entities/order.entity';

const ORDER_INCLUDE = {
  salesperson: { select: { name: true, email: true } },
  attachments: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.OrderInclude;

/** 临时附件（已上传未关联）的最大保留时长 */
const TEMP_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** 库存编号碰撞时的最大重试次数（16^6 随机空间，实际几乎不会触发） */
const INVENTORY_CODE_ATTEMPTS = 5;

/** 订单表单联动库存时可直接落库的字段（不含 code / orderId / createdById） */
type OrderInventoryData = {
  productName: string;
  productDetail: string;
  quantity: string;
  unit: string;
  location: string;
  storedAt: Date;
};

/** 一次订单写入对库存造成的实际影响（用于审计与返回提示） */
type InventoryOutcome = {
  action: 'created' | 'updated' | 'deleted';
  id: string;
  code: string;
};

/** 简易魔数校验（与媒体库同等强度的内容/声明一致性检查） */
const FILE_SIGNATURES: { mime: string; bytes: number[][] }[] = [
  { mime: 'image/jpeg', bytes: [[0xff, 0xd8, 0xff]] },
  { mime: 'image/png', bytes: [[0x89, 0x50, 0x4e, 0x47]] },
  { mime: 'image/webp', bytes: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF（webp 容器）
];

function verifyImageSignature(buffer: Buffer, mimeType: string): boolean {
  const sig = FILE_SIGNATURES.find((s) => s.mime === mimeType);
  if (!sig) return false;
  return sig.bytes.some((candidate) =>
    candidate.every((byte, index) => buffer[index] === byte),
  );
}

function sanitizeOriginalName(originalName: string): string {
  const base = path.basename(originalName.replace(/\\/g, '/'));
  const safe = base.replace(/[^\p{L}\p{N}._-]/gu, '_');
  return (safe || 'unnamed').slice(0, 200);
}

/**
 * 订单管理服务（Phase 5.2）。
 *
 * 权限模型：
 *   · 管理员 = isSuperAdmin 或持有 orders.manage 语义（当前实现：isSuperAdmin）→ 查看全部订单
 *     —— 说明：跨业务员查看属管理员能力；如需下放给自定义角色，
 *     可在 registry 增加 orders.manage 后在此放宽（预留 samples.manage 同型逻辑）
 *   · 普通业务员 → 仅可见/可改自己的订单（后端从会话确定归属，不信任前端传入 ID）
 *
 * 图片隔离：
 *   · 附件存 OrderAttachment（独立表），媒体库（MediaAsset）查询天然不涉及
 *   · 文件存 orders/ 命名空间（非静态目录），读取必须经鉴权接口
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly audit: AuditLogService,
    private readonly files: OrderFileService,
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

  /* ------------------------------ 上传 ------------------------------ */

  /** 上传订单照片（临时态，orderId 为空；保存订单时关联） */
  async uploadAttachment(
    actor: ActorContext,
    file: Express.Multer.File,
  ): Promise<OrderAttachmentDto> {
    if (!file) throw new BadRequestException('请上传文件');
    const mime = file.mimetype;
    if (!ORDER_ATTACHMENT_MIME[mime]) {
      throw new BadRequestException('订单照片仅支持 jpeg / png / webp');
    }
    if (!verifyImageSignature(file.buffer, mime)) {
      throw new BadRequestException('文件内容与声明格式不符（须通过魔数校验）');
    }
    const storageKey = await this.files.save(file.buffer, mime);

    // 顺带清理超过 TTL 的孤立临时附件（上传后未关联订单的残留）
    void this.purgeStaleTempAttachments().catch((error) =>
      this.logger.warn(`临时附件清理失败: ${String(error)}`),
    );

    const created = await this.prisma.orderAttachment.create({
      data: {
        originalName: sanitizeOriginalName(file.originalname),
        storageKey,
        mimeType: mime,
        size: file.size,
        uploadedById: actor.id,
      },
    });
    return this.toAttachmentDto(created);
  }

  /* ------------------------------ 订单 CRUD ------------------------------ */

  async list(actor: ActorContext, query: ListOrdersQueryDto): Promise<Paginated<OrderDto>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const admin = this.isAdmin(actor);

    const where: Prisma.OrderWhereInput = {};
    if (admin) {
      if (query.salespersonId) where.salespersonId = query.salespersonId;
    } else {
      where.salespersonId = actor.id;
    }
    if (query.country) where.country = { contains: query.country, mode: 'insensitive' };
    if (query.closedState === 'closed') where.closedAt = { not: null };
    if (query.closedState === 'open') where.closedAt = null;
    if (query.orderedFrom || query.orderedTo) {
      where.orderedAt = {
        ...(query.orderedFrom ? { gte: new Date(query.orderedFrom) } : {}),
        ...(query.orderedTo ? { lte: new Date(query.orderedTo) } : {}),
      };
    }
    if (query.keyword) {
      where.OR = [
        { code: { contains: query.keyword, mode: 'insensitive' } },
        { customerName: { contains: query.keyword, mode: 'insensitive' } },
        { requirement: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    // 订单编号精确查询（Phase 5.3；与其余筛选叠加，仍受角色权限过滤保护）
    if (query.code) where.code = query.code.trim();

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
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

  async detail(actor: ActorContext, id: string): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('订单不存在');
    if (!this.isAdmin(actor) && order.salespersonId !== actor.id) {
      throw new NotFoundException('订单不存在'); // 不泄漏他人订单存在性
    }
    return this.toDto(order);
  }

  /**
   * 新建订单（Phase 5.3.2：可选同事务创建关联库存）。
   *
   * 事务边界：订单行 + 库存行在同一个 $transaction 内写入，
   * 任一失败整体回滚 —— 不会出现「订单建好了但库存没建」或
   * 「库存建好了但订单没建」的中间态。
   *
   * 订单编号冲突（P2002）：先判断是否订单号被占用（并发），是则 409；
   * 否则视为库存编号随机碰撞，换码重试（上限 5 次）。
   */
  async create(actor: ActorContext, dto: CreateOrderDto): Promise<OrderDto> {
    this.validateDates(dto.orderedAt, dto.closedAt);
    await this.assertAttachmentsAvailable(actor, dto.attachmentIds ?? []);

    // 订单编号由业务员手动填写（Phase 5.3）：规范化仅 trim 首尾，
    // 大小写不折叠（与数据库唯一索引一致）；重复时 P2002 → 409 业务错误。
    const code = dto.code.trim();
    const inventoryData = dto.inventory ? this.buildInventoryData(dto.inventory) : null;

    // 预检订单号，给出精确的业务提示（并发窗口由唯一索引 + catch 兜底）
    const duplicated = await this.prisma.order.findUnique({
      where: { code },
      select: { id: true },
    });
    if (duplicated) throw new ConflictException('该订单号已存在，请检查后重新输入');

    let written: { order: { id: string; code: string }; inventory: InventoryOutcome | null } | null =
      null;

    for (let attempt = 0; attempt < INVENTORY_CODE_ATTEMPTS && !written; attempt++) {
      const inventoryCode = inventoryData ? generateInventoryCode() : null;
      try {
        written = await this.prisma.$transaction(async (tx) => {
          const order = await tx.order.create({
            data: {
              code,
              salespersonId: actor.id,
              customerName: dto.customerName,
              country: dto.country,
              requirement: dto.requirement,
              orderedAt: new Date(dto.orderedAt),
              closedAt: dto.closedAt ? new Date(dto.closedAt) : null,
              amount: dto.amount.toFixed(2),
              currency: dto.currency,
              note: dto.note ?? null,
            },
            select: { id: true, code: true },
          });

          const inventory =
            inventoryData && inventoryCode
              ? await tx.inventoryItem.create({
                  data: {
                    ...inventoryData,
                    code: inventoryCode,
                    orderId: order.id,
                    createdById: actor.id,
                  },
                  select: { id: true, code: true },
                })
              : null;

          return {
            order,
            inventory: inventory
              ? { action: 'created' as const, id: inventory.id, code: inventory.code }
              : null,
          };
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        ) {
          throw error;
        }
        // 数据库唯一约束兜底：并发创建相同订单号时只有一个成功
        const taken = await this.prisma.order.findUnique({
          where: { code },
          select: { id: true },
        });
        if (taken) throw new ConflictException('该订单号已存在，请检查后重新输入');
        if (attempt === INVENTORY_CODE_ATTEMPTS - 1) {
          throw new ConflictException('库存编号生成冲突，请重试');
        }
      }
    }
    if (!written) throw new ConflictException('库存编号生成冲突，请重试');

    // 附件关联（事务：全部归属校验通过才绑定；任何附件被他人占用 → 整体失败）
    await this.attachAttachments(actor, written.order.id, dto.attachmentIds ?? []);

    await this.audit.record({
      actor,
      action: 'order.create',
      targetType: 'order',
      targetId: written.order.id,
      summary: `新建订单 ${written.order.code}（${dto.customerName}）`,
      diff: {
        amount: dto.amount,
        currency: dto.currency,
        attachments: (dto.attachmentIds ?? []).length,
        inventory: written.inventory?.code ?? null,
      },
    });
    if (written.inventory) {
      await this.audit.record({
        actor,
        action: 'inventory.create',
        targetType: 'inventory_item',
        targetId: written.inventory.id,
        summary: `随订单 ${written.order.code} 新增库存 ${written.inventory.code}（${dto.inventory!.productName.trim()}）`,
        diff: { orderId: written.order.id, source: 'order-form' },
      });
    }
    return this.detail(actor, written.order.id);
  }

  /**
   * 编辑订单（Phase 5.3.2：可选同事务更新/新建/删除关联库存）。
   *
   * 库存语义（三选一，由前端显式表达）：
   *   · inventory 有值      → 更新该订单已有主库存；无则新建一条；
   *   · removeInventory=true → 删除主库存（必须经用户二次确认）；
   *   · 两者都不传           → 完全不触碰库存。
   *
   * 「主库存」= 该订单最早创建的一条库存记录（createdAt asc, id asc）。
   * 订单可能有从库存列表额外新增的多条记录，本表单只编辑主记录，
   * 其余记录请在库存列表中管理 —— 避免一次保存误改/误删多条。
   */
  async update(actor: ActorContext, id: string, dto: UpdateOrderDto): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('订单不存在');
    if (!this.isAdmin(actor) && order.salespersonId !== actor.id) {
      throw new ForbiddenException('只能编辑自己的订单');
    }
    this.validateDates(dto.orderedAt, dto.closedAt);

    if (dto.removeInventory && dto.inventory) {
      throw new BadRequestException('不能同时提交库存信息与删除库存，请二选一');
    }

    const inventoryData = dto.inventory ? this.buildInventoryData(dto.inventory) : null;
    const primary = await this.prisma.inventoryItem.findFirst({
      where: { orderId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, code: true },
    });

    const needsNewCode = Boolean(inventoryData) && !primary && !dto.removeInventory;
    let done = false;
    let outcome: InventoryOutcome | null = null;

    for (let attempt = 0; attempt < INVENTORY_CODE_ATTEMPTS && !done; attempt++) {
      const newCode = needsNewCode ? generateInventoryCode() : null;
      try {
        outcome = await this.prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id },
            data: {
              customerName: dto.customerName,
              country: dto.country,
              requirement: dto.requirement,
              orderedAt: new Date(dto.orderedAt),
              closedAt: dto.closedAt ? new Date(dto.closedAt) : null,
              amount: dto.amount.toFixed(2),
              currency: dto.currency,
              note: dto.note ?? null,
            },
          });

          if (dto.removeInventory) {
            if (!primary) return null;
            await tx.inventoryItem.delete({ where: { id: primary.id } });
            return { action: 'deleted' as const, id: primary.id, code: primary.code };
          }
          if (!inventoryData) return null;
          if (primary) {
            await tx.inventoryItem.update({ where: { id: primary.id }, data: inventoryData });
            return { action: 'updated' as const, id: primary.id, code: primary.code };
          }
          if (!newCode) return null;
          const created = await tx.inventoryItem.create({
            data: { ...inventoryData, code: newCode, orderId: id, createdById: actor.id },
            select: { id: true, code: true },
          });
          return { action: 'created' as const, id: created.id, code: created.code };
        });
        done = true;
      } catch (error) {
        if (
          newCode &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          if (attempt === INVENTORY_CODE_ATTEMPTS - 1) {
            throw new ConflictException('库存编号生成冲突，请重试');
          }
          continue;
        }
        throw error;
      }
    }

    // 新增附件
    await this.attachAttachments(actor, id, dto.attachmentIds ?? []);
    // 移除附件（必须属于本订单；DB 行与文件先后删除）
    for (const attId of dto.removeAttachmentIds ?? []) {
      const att = await this.prisma.orderAttachment.findUnique({ where: { id: attId } });
      if (!att || att.orderId !== id) {
        throw new BadRequestException('存在不属于本订单的待移除附件');
      }
      await this.prisma.orderAttachment.delete({ where: { id: attId } });
      await this.files.remove(att.storageKey);
    }

    await this.audit.record({
      actor,
      action: 'order.update',
      targetType: 'order',
      targetId: id,
      summary: `编辑订单 ${order.code}`,
      diff: { inventory: outcome ? `${outcome.action}:${outcome.code}` : null },
    });

    if (outcome) {
      const label =
        outcome.action === 'deleted' ? '删除' : outcome.action === 'created' ? '新增' : '更新';
      await this.audit.record({
        actor,
        action: `inventory.${outcome.action}`,
        targetType: 'inventory_item',
        targetId: outcome.id,
        summary: `随订单 ${order.code} ${label}库存 ${outcome.code}`,
        diff: { orderId: id, source: 'order-form' },
      });
    }

    return this.detail(actor, id);
  }

  /* ------------------------------ 附件 ------------------------------ */

  /** 附件列表（仅订单可见者） */
  async listAttachments(actor: ActorContext, orderId: string): Promise<OrderAttachmentDto[]> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('订单不存在');
    if (!this.isAdmin(actor) && order.salespersonId !== actor.id) {
      throw new NotFoundException('订单不存在');
    }
    return order.attachments.map((a) => this.toAttachmentDto(a));
  }

  /** 附件文件流（鉴权：管理员或订单归属业务员） */
  async readAttachmentFile(
    actor: ActorContext,
    orderId: string,
    attachmentId: string,
  ): Promise<{ filename: string; mime: string; data: Buffer }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { salespersonId: true },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (!this.isAdmin(actor) && order.salespersonId !== actor.id) {
      throw new NotFoundException('订单不存在');
    }
    const att = await this.prisma.orderAttachment.findUnique({ where: { id: attachmentId } });
    if (!att || att.orderId !== orderId) {
      throw new NotFoundException('订单图片不存在');
    }
    const data = await this.files.read(att.storageKey);
    return { filename: att.originalName, mime: att.mimeType, data };
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * 订单表单内联库存 → 可直接落库的字段。
   * 校验规则与库存模块一致（数量非负 + 最多三位小数，Decimal(14,3) 存储）。
   */
  private buildInventoryData(dto: OrderInventoryDto): OrderInventoryData {
    return {
      productName: dto.productName.trim(),
      productDetail: dto.productDetail.trim(),
      quantity: toInventoryQuantity(dto.quantity).toFixed(3),
      unit: dto.unit,
      location: dto.location.trim(),
      storedAt: new Date(dto.storedAt),
    };
  }

  private validateDates(orderedAt: string, closedAt?: string) {
    const o = new Date(orderedAt);
    if (Number.isNaN(o.getTime())) throw new BadRequestException('下单时间不合法');
    if (closedAt) {
      const c = new Date(closedAt);
      if (Number.isNaN(c.getTime())) throw new BadRequestException('成交时间不合法');
      if (c.getTime() < o.getTime()) {
        throw new BadRequestException('成交时间不能早于下单时间');
      }
    }
  }

  /** 关联前校验：附件必须是当前用户上传且尚未关联订单的临时态 */
  private async assertAttachmentsAvailable(actor: ActorContext, attachmentIds: string[]) {
    if (attachmentIds.length > 10) {
      throw new BadRequestException('订单照片最多 10 张');
    }
    if (attachmentIds.length === 0) return;
    const rows = await this.prisma.orderAttachment.findMany({
      where: { id: { in: attachmentIds } },
    });
    for (const id of attachmentIds) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new BadRequestException('存在无效的订单图片');
      if (row.uploadedById !== actor.id) {
        throw new ForbiddenException('不能关联其他用户上传的图片');
      }
      if (row.orderId) {
        throw new ConflictException('部分图片已被其他订单关联，请重新上传');
      }
    }
  }

  /** 事务内绑定附件（校验 + updateMany 条件更新，防并发重复关联） */
  private async attachAttachments(actor: ActorContext, orderId: string, attachmentIds: string[]) {
    if (attachmentIds.length === 0) return;
    await this.assertAttachmentsAvailable(actor, attachmentIds);
    await this.prisma.$transaction(async (tx) => {
      for (const id of attachmentIds) {
        const bound = await tx.orderAttachment.updateMany({
          where: { id, orderId: null, uploadedById: actor.id },
          data: { orderId },
        });
        if (bound.count !== 1) {
          throw new ConflictException('图片关联失败（可能已被并发绑定），请刷新后重试');
        }
      }
    });
  }

  /** 清理超过 TTL 的孤立临时附件（含磁盘文件） */
  private async purgeStaleTempAttachments(): Promise<void> {
    const cutoff = new Date(Date.now() - TEMP_ATTACHMENT_TTL_MS);
    const stale = await this.prisma.orderAttachment.findMany({
      where: { orderId: null, createdAt: { lt: cutoff } },
      select: { id: true, storageKey: true },
    });
    for (const row of stale) {
      await this.prisma.orderAttachment.delete({ where: { id: row.id } }).catch(() => undefined);
      await this.files.remove(row.storageKey);
    }
  }

  private toAttachmentDto(att: {
    id: string;
    originalName: string;
    mimeType: string;
    size: number;
    createdAt: Date;
  }): OrderAttachmentDto {
    return {
      id: att.id,
      originalName: att.originalName,
      mimeType: att.mimeType,
      size: att.size,
      createdAt: att.createdAt,
    };
  }

  private toDto(order: {
    id: string;
    code: string;
    salespersonId: string;
    customerName: string;
    country: string;
    requirement: string;
    orderedAt: Date;
    closedAt: Date | null;
    amount: Prisma.Decimal;
    currency: OrderCurrency;
    note: string | null;
    createdAt: Date;
    updatedAt: Date;
    salesperson: { name: string | null };
    attachments: {
      id: string;
      originalName: string;
      mimeType: string;
      size: number;
      createdAt: Date;
    }[];
  }): OrderDto {
    return {
      id: order.id,
      code: order.code,
      salespersonId: order.salespersonId,
      salespersonName: order.salesperson.name,
      customerName: order.customerName,
      country: order.country,
      requirement: order.requirement,
      orderedAt: order.orderedAt,
      closedAt: order.closedAt,
      amount: order.amount.toFixed(2),
      currency: order.currency,
      note: order.note,
      attachments: order.attachments.map((a) => this.toAttachmentDto(a)),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}
