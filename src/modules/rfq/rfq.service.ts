import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, ProductStatus, RfqStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRfqDto } from './dto/create-rfq.dto';
import { ListRfqQueryDto } from './dto/list-rfq-query.dto';
import {
  PaginatedRfqDto,
  RfqDetailDto,
  RfqReceiptDto,
  RFQ_ASSIGNEE_SELECT,
  toRfqDetail,
  toRfqListItem,
  toRfqReceipt,
} from './rfq.dto';
import { LeadDistributionService } from '../cms/lead-distribution/lead-distribution.service';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** 创建询盘时记录的来源信息（仅用于风控/统计，不属敏感信息） */
export interface RfqSourceMeta {
  sourceIp?: string | null;
  userAgent?: string | null;
}

/**
 * RFQ 询盘服务。
 *
 * 业务链路：访客提交（create）→ 后台查看（list / findById）→ 状态流转（updateStatus）。
 * 不包含任何价格 / 订单 / 支付逻辑（百灵木业为 B2B 制造商，报价在邮件中完成）。
 */
@Injectable()
export class RfqService {
  private readonly logger = new Logger(RfqService.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * 询盘分配引擎（Phase 4.6）。
     *
     * 用 @Optional() 注入：单元测试只提供 PrismaService 时不会因缺少 provider 而启动失败，
     * 此时退化为「不自动分配」，既有测试行为不变。
     */
    @Optional() private readonly leadDistribution?: LeadDistributionService,
  ) {}

  /**
   * 创建询盘。
   *
   * 产品关联策略：若传入 productId，则校验其为**已发布**产品并快照其名称；
   * 若 productId 无效（已被删除 / 未发布 / 伪造），则**丢弃该关联但不拒绝提交**
   * —— 询盘是核心销售线索，不应因产品引用失效而丢失。
   *
   * 自动分配（Phase 4.6）：询盘落库后在同一事务内按「倾斜计划 / 正常轮询」分配承接人。
   * 分配失败**不影响**询盘入库——销售线索优先，引擎故障只记错误日志。
   */
  async create(dto: CreateRfqDto, meta: RfqSourceMeta = {}): Promise<RfqReceiptDto> {
    let productId: string | null = null;
    let productName: string | null = dto.productName?.trim() || null;

    if (dto.productId) {
      const product = await this.prisma.product.findFirst({
        where: { id: dto.productId, status: ProductStatus.PUBLISHED },
        select: { id: true, name: true },
      });
      if (product) {
        productId = product.id;
        productName = productName ?? product.name;
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const rfq = await tx.rfq.create({
        data: {
          name: dto.name,
          company: dto.company,
          email: dto.email,
          phone: dto.phone ?? null,
          country: dto.country,
          productId,
          productName,
          message: dto.message,
          quantity: dto.quantity ?? null,
          attachmentUrl: dto.attachmentUrl ?? null,
          sourceIp: meta.sourceIp ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });

      if (this.leadDistribution) {
        try {
          const outcome = await this.leadDistribution.assignToRfq(rfq.id, tx);
          if (outcome) {
            this.logger.log(
              `询盘 ${rfq.id} 已自动分配给 ${outcome.assigneeEmail}` +
                `（${outcome.source === 'PRIORITY_PLAN' ? `倾斜计划 ${outcome.planName}` : '正常轮询'}）`,
            );
          }
        } catch (error) {
          // 分配引擎异常绝不丢线索：记录错误，询盘保持「未分配」可人工补派
          this.logger.error(
            `询盘 ${rfq.id} 自动分配失败（询盘已保存，保持未分配）：` +
              (error instanceof Error ? error.message : String(error)),
            error instanceof Error ? error.stack : undefined,
          );
        }
      }

      return rfq;
    });

    return toRfqReceipt(created);
  }

  /** 后台列表：分页 + 状态/承接人筛选，最新提交在前 */
  async list(query: ListRfqQueryDto): Promise<PaginatedRfqDto> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.RfqWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.assigneeId) where.assigneeId = query.assigneeId;
    if (query.assigned === true) where.assigneeId = { not: null };
    if (query.assigned === false) where.assigneeId = null;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.rfq.count({ where }),
      this.prisma.rfq.findMany({
        where,
        include: RFQ_ASSIGNEE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map(toRfqListItem),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /** 后台详情 */
  async findById(id: string): Promise<RfqDetailDto> {
    const rfq = await this.prisma.rfq.findUnique({
      where: { id },
      include: RFQ_ASSIGNEE_SELECT,
    });
    if (!rfq) throw new NotFoundException('RFQ not found');
    return toRfqDetail(rfq);
  }

  /** 状态流转：NEW → CONTACTED → QUOTED → CLOSED */
  async updateStatus(id: string, status: RfqStatus): Promise<RfqDetailDto> {
    const exists = await this.prisma.rfq.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('RFQ not found');

    const updated = await this.prisma.rfq.update({
      where: { id },
      data: { status },
      include: RFQ_ASSIGNEE_SELECT,
    });
    return toRfqDetail(updated);
  }
}
