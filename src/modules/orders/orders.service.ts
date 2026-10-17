import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderCurrency, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../rbac/audit-log.service';
import { RbacService } from '../rbac/rbac.service';
import type { ActorContext } from '../rbac/actor-context';
import type { AuthUser } from '../auth/auth.types';
import { CreateOrderDto, ListOrdersQueryDto, UpdateOrderDto } from './dto/orders.dto';
import { OrderFileService, ORDER_ATTACHMENT_MIME } from './order-file.service';
import type { OrderAttachmentDto, OrderDto, Paginated } from './entities/order.entity';

const ORDER_INCLUDE = {
  salesperson: { select: { name: true, email: true } },
  attachments: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.OrderInclude;

/** 临时附件（已上传未关联）的最大保留时长 */
const TEMP_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

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

  async create(actor: ActorContext, dto: CreateOrderDto): Promise<OrderDto> {
    this.validateDates(dto.orderedAt, dto.closedAt);
    await this.assertAttachmentsAvailable(actor, dto.attachmentIds ?? []);

    let created;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        created = await this.prisma.order.create({
          data: {
            code: this.generateCode('SO'),
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
          include: ORDER_INCLUDE,
        });
        break;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          if (attempt === 4) throw new ConflictException('订单编号生成冲突，请重试');
          continue;
        }
        throw error;
      }
    }

    // 附件关联（事务：全部归属校验通过才绑定；任何附件被他人占用 → 整体失败）
    await this.attachAttachments(actor, created!.id, dto.attachmentIds ?? []);

    await this.audit.record({
      actor,
      action: 'order.create',
      targetType: 'order',
      targetId: created!.id,
      summary: `新建订单 ${created!.code}（${dto.customerName}）`,
      diff: { amount: dto.amount, currency: dto.currency, attachments: (dto.attachmentIds ?? []).length },
    });
    return this.detail(actor, created!.id);
  }

  async update(actor: ActorContext, id: string, dto: UpdateOrderDto): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('订单不存在');
    if (!this.isAdmin(actor) && order.salespersonId !== actor.id) {
      throw new ForbiddenException('只能编辑自己的订单');
    }
    this.validateDates(dto.orderedAt, dto.closedAt);

    const updated = await this.prisma.order.update({
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
      include: ORDER_INCLUDE,
    });

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
    });
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

  private generateCode(prefix: string): string {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    const rand = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    return `${prefix}-${ymd}-${rand}`;
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
