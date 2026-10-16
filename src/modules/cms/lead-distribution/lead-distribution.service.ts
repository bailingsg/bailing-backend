import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LeadAssignmentSource, LeadPlanStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../rbac/audit-log.service';
import type { ActorContext } from '../../rbac/actor-context';
import {
  ClosePlanDto,
  CreatePlanDto,
  ListAssignmentsQueryDto,
  ListPlanLogsQueryDto,
  UpdatePlanDto,
} from './dto/lead-distribution.dto';
import type {
  AssignmentDto,
  CreatePlanResultDto,
  EligibleAssigneeDto,
  LeadDistributionStateDto,
  PaginatedAssignmentsDto,
  PlanDto,
  PlanItemProgressDto,
  PlanLogDto,
  QueueMemberDto,
} from './entities/lead-distribution.entity';

/** 正常轮询指针单例行 id（表内永远只有一行） */
const RR_SINGLETON_ID = 'round-robin';
/** 首页「最近分配记录」条数 */
const RECENT_LIMIT = 10;
/** 趋势图天数 */
const DAILY_DAYS = 7;
/** 操作历史默认条数 */
const DEFAULT_LOG_TAKE = 30;

/** 事务客户端或普通客户端（分配引擎两种都要能用） */
type Db = PrismaService | Prisma.TransactionClient;

/** 队列中的一名可分配员工 */
interface QueueEmployee {
  adminUserId: string;
  name: string | null;
  email: string;
  jobTitle: string | null;
  sortOrder: number;
  createdAt: Date;
}

/** 轮询指针快照 */
interface RoundRobinPointer {
  lastAssigneeId: string | null;
  lastIndex: number;
}

const PLAN_ITEM_INCLUDE = {
  adminUser: {
    select: {
      id: true,
      name: true,
      email: true,
      jobTitle: true,
      isActive: true,
      createdAt: true,
      contact: { select: { isLeadContact: true } },
    },
  },
} satisfies Prisma.LeadDistributionItemInclude;

const PLAN_INCLUDE = {
  items: { include: PLAN_ITEM_INCLUDE },
} satisfies Prisma.LeadDistributionPlanInclude;

type PlanItemRow = Prisma.LeadDistributionItemGetPayload<{ include: typeof PLAN_ITEM_INCLUDE }>;
type PlanRow = Prisma.LeadDistributionPlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

const ASSIGNMENT_INCLUDE = {
  rfq: {
    select: { name: true, company: true, country: true, productName: true, status: true },
  },
  assignee: { select: { id: true, name: true, email: true } },
  plan: { select: { id: true, name: true } },
} satisfies Prisma.LeadAssignmentInclude;

type AssignmentRow = Prisma.LeadAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>;

/** 一次分配的完整结果（供 RFQ 集成与测试断言） */
export interface AssignmentOutcome {
  rfqId: string;
  assigneeId: string;
  assigneeName: string | null;
  assigneeEmail: string;
  source: LeadAssignmentSource;
  /** 正常轮询时的队列位置（倾斜计划为 null） */
  roundRobinIndex: number | null;
  planId: string | null;
  planName: string | null;
}

/** 倾斜员工条目（含资格判定） */
interface TiltCandidate {
  item: PlanItemRow;
  index: number;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

function dateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 按（sortOrder, 加入时间）稳定排序倾斜条目 */
function sortPlanItems(items: PlanItemRow[]): PlanItemRow[] {
  return [...items].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const diff = a.adminUser.createdAt.getTime() - b.adminUser.createdAt.getTime();
    return diff !== 0 ? diff : a.adminUserId < b.adminUserId ? -1 : 1;
  });
}

/** 条目当前是否有效（账号启用且仍是询盘联系人） */
function isItemEligible(item: PlanItemRow): boolean {
  return item.adminUser.isActive === true && item.adminUser.contact?.isLeadContact === true;
}

/** 全部条目是否都已达标（只依赖两个计数，便于复用） */
function allItemsAtTarget(
  items: { targetCount: number; assignedCount: number }[],
): boolean {
  return items.length > 0 && items.every((i) => i.assignedCount >= i.targetCount);
}

/** 计划是否真正生效（决定分配模式） */
function isPlanInEffect(plan: PlanRow, now: Date): boolean {
  if (plan.status !== LeadPlanStatus.ACTIVE) return false;
  if (plan.startAt.getTime() > now.getTime()) return false;
  if (plan.endAt && plan.endAt.getTime() <= now.getTime()) return false;
  return !allItemsAtTarget(plan.items);
}

/** 计划当前是否还有可接单的倾斜员工（账号启用、未达标） */
export function hasTiltCapacity(plan: PlanRow): boolean {
  return sortPlanItems(plan.items).some(
    (item) => isItemEligible(item) && item.assignedCount < item.targetCount,
  );
}

/** 计算下一个正常轮询承接人的队列下标（不改变任何状态） */
function nextRoundRobinIndex(queue: QueueEmployee[], pointer: RoundRobinPointer | null): number | null {
  if (queue.length === 0) return null;
  if (!pointer || pointer.lastAssigneeId === null) return 0;
  const pos = queue.findIndex((m) => m.adminUserId === pointer.lastAssigneeId);
  if (pos >= 0) return (pos + 1) % queue.length;
  // 上次承接人已退出队列（账号停用 / 取消询盘联系人身份）：按上次序号顺延，越界回队首
  const fallback = pointer.lastIndex + 1;
  return fallback >= 0 && fallback < queue.length ? fallback : 0;
}

/**
 * 询盘分配引擎（Phase 4.6 核心）。
 *
 * 设计原则：
 *   1. **指针落库，不落内存**：正常轮询指针存放在 `lead_round_robin_state` 单例行，
 *      服务重启 / 多实例部署都不会丢顺序；倾斜计划的组内指针由该计划自己的
 *      `LeadAssignment` 记录推导（同计划内按创建时间取最后一条）。
 *   2. **两种模式互斥**：同一时刻要么正常轮询、要么执行倾斜计划；
 *      倾斜期间**不动**正常轮询指针，计划结束后原顺序原样恢复。
 *   3. **串行化写**：分配前对轮询指针行加 `FOR UPDATE` 排他锁，
 *      并发提交 / 重复请求都不会把同一批询盘塞给同一个人。
 *   4. **资格实时判定**：账号停用、取消询盘联系人身份的员工立即退出队列，
 *      计划条目同步标记为不可分配（页面显示「账号已停用」），但历史归属保留。
 *   5. **零分配不阻塞询盘**：无人可分配时返回 null，询盘仍正常入库（等队列有人再接）。
 */
@Injectable()
export class LeadDistributionService {
  private readonly logger = new Logger(LeadDistributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  // ────────────────── 分配引擎（RFQ 创建时调用） ──────────────────

  /**
   * 给一条询盘分配承接人。
   *
   * @param rfqId 询盘 id（必须已存在）
   * @param tx    可选：复用调用方的事务（RFQ 创建事务），保证「询盘 + 分配」原子
   * @returns 分配结果；队列为空时返回 null（询盘保持未分配）
   */
  async assignToRfq(
    rfqId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AssignmentOutcome | null> {
    if (tx) return this.doAssign(rfqId, tx);
    return this.prisma.$transaction((client) => this.doAssign(rfqId, client));
  }

  private async doAssign(rfqId: string, db: Db): Promise<AssignmentOutcome | null> {
    // 1) 读取询盘；已分配过则保持原样（重复请求不重复接单）
    const rfq = await db.rfq.findUnique({
      where: { id: rfqId },
      select: {
        id: true,
        assigneeId: true,
        assignee: { select: { id: true, name: true, email: true } },
      },
    });
    if (!rfq) throw new NotFoundException('询盘不存在，无法分配');
    if (rfq.assigneeId && rfq.assignee) {
      const existing = await db.leadAssignment.findFirst({
        where: { rfqId },
        orderBy: { createdAt: 'desc' },
        select: { source: true, planId: true, plan: { select: { name: true } } },
      });
      return {
        rfqId,
        assigneeId: rfq.assignee.id,
        assigneeName: rfq.assignee.name,
        assigneeEmail: rfq.assignee.email,
        source: existing?.source ?? LeadAssignmentSource.ROUND_ROBIN,
        roundRobinIndex: null,
        planId: existing?.planId ?? null,
        planName: existing?.plan?.name ?? null,
      };
    }

    // 2) 抢占轮询指针行锁：并发分配串行化，避免两次分配选中同一人
    await this.lockRoundRobinState(db);

    // 3) 锁后重新读指针，并解析当前计划（含惰性状态迁移）
    const now = new Date();
    const [pointer, queue, plan] = await Promise.all([
      this.loadPointer(db),
      this.loadQueue(db),
      this.resolveCurrentPlan(db, now),
    ]);

    let assigneeId: string;
    let source: LeadAssignmentSource;
    let roundRobinIndex: number | null = null;
    let planId: string | null = null;
    let planName: string | null = null;
    let tiltItemId: string | null = null;
    let queueIndex: number | null = null;

    if (plan && isPlanInEffect(plan, now)) {
      const picked = await this.pickTiltAssignee(db, plan);
      if (picked) {
        assigneeId = picked.item.adminUserId;
        source = LeadAssignmentSource.PRIORITY_PLAN;
        planId = plan.id;
        planName = plan.name;
        tiltItemId = picked.item.id;
      } else {
        assigneeId = '';
        source = LeadAssignmentSource.ROUND_ROBIN;
      }
    } else {
      assigneeId = '';
      source = LeadAssignmentSource.ROUND_ROBIN;
    }

    // 4) 倾斜计划无人可接（全部停用 / 全部达标）时，回落到正常轮询
    if (!assigneeId) {
      const idx = nextRoundRobinIndex(queue, pointer);
      if (idx === null) {
        this.logger.warn(`询盘 ${rfqId} 未分配：当前没有可分配的询盘联系人（队列为空）`);
        return null;
      }
      assigneeId = queue[idx].adminUserId;
      roundRobinIndex = idx;
      queueIndex = idx;
      source = LeadAssignmentSource.ROUND_ROBIN;
    }

    const assignee = await db.adminUser.findUniqueOrThrow({
      where: { id: assigneeId },
      select: { id: true, name: true, email: true },
    });

    // 5) 同一事务内写：分配记录 + 询盘归属 + 指针/计划进度
    await db.leadAssignment.create({
      data: {
        rfqId,
        assigneeId,
        source,
        roundRobinIndex,
        planId,
      },
    });
    await db.rfq.update({
      where: { id: rfqId },
      data: { assigneeId, assignedAt: now },
    });

    if (source === LeadAssignmentSource.ROUND_ROBIN) {
      await db.leadRoundRobinState.upsert({
        where: { id: RR_SINGLETON_ID },
        create: {
          id: RR_SINGLETON_ID,
          lastAssigneeId: assigneeId,
          lastIndex: roundRobinIndex ?? 0,
          cycleCount: 1,
        },
        update: {
          lastAssigneeId: assigneeId,
          lastIndex: roundRobinIndex ?? 0,
          cycleCount: { increment: 1 },
        },
      });
      this.logger.log(
        `询盘分配[轮询] rfq=${rfqId} → ${assignee.email} (队列位 #${roundRobinIndex})`,
      );
    } else {
      await db.leadDistributionItem.update({
        where: { id: tiltItemId! },
        data: { assignedCount: { increment: 1 } },
      });
      const items = await db.leadDistributionItem.findMany({
        where: { planId: planId! },
        select: { targetCount: true, assignedCount: true },
      });
      this.logger.log(
        `询盘分配[倾斜计划 ${planName}] rfq=${rfqId} → ${assignee.email}` +
          `（计划进度 ${items.reduce((s, i) => s + i.assignedCount, 0)}` +
          `/${items.reduce((s, i) => s + i.targetCount, 0)}）`,
      );
      // 全部条目达标 → 计划自动完成，后续询盘立即回到正常轮询
      if (allItemsAtTarget(items)) {
        await this.completePlanInTx(db, plan!, 'targets_reached');
      }
    }

    return {
      rfqId,
      assigneeId,
      assigneeName: assignee.name,
      assigneeEmail: assignee.email,
      source,
      roundRobinIndex,
      planId,
      planName,
    };
  }

  /** 确保轮询指针单例行存在，并对其加排他锁（并发安全） */
  private async lockRoundRobinState(db: Db): Promise<void> {
    await db.$executeRaw`
      INSERT INTO lead_round_robin_state (id, "lastIndex", "cycleCount", "updatedAt")
      VALUES (${RR_SINGLETON_ID}, -1, 0, NOW())
      ON CONFLICT (id) DO NOTHING`;
    await db.$queryRaw`
      SELECT id FROM lead_round_robin_state WHERE id = ${RR_SINGLETON_ID} FOR UPDATE`;
  }

  private async loadPointer(db: Db): Promise<RoundRobinPointer | null> {
    const state = await db.leadRoundRobinState.findUnique({
      where: { id: RR_SINGLETON_ID },
      select: { lastAssigneeId: true, lastIndex: true },
    });
    return state ?? null;
  }

  /**
   * 可分配队列：员工账号启用中 **且** 被标记为询盘联系人。
   * 排序 = EmployeeContact.sortOrder 升序，其次加入时间升序（前端展示顺序即分配顺序）。
   */
  private async loadQueue(db: Db): Promise<QueueEmployee[]> {
    const contacts = await db.employeeContact.findMany({
      where: { isLeadContact: true, adminUser: { isActive: true } },
      select: {
        adminUserId: true,
        sortOrder: true,
        adminUser: {
          select: {
            id: true,
            name: true,
            email: true,
            jobTitle: true,
            createdAt: true,
          },
        },
      },
    });

    return contacts
      .map((c) => ({
        adminUserId: c.adminUserId,
        name: c.adminUser.name,
        email: c.adminUser.email,
        jobTitle: c.adminUser.jobTitle,
        sortOrder: c.sortOrder,
        createdAt: c.adminUser.createdAt,
      }))
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        const diff = a.createdAt.getTime() - b.createdAt.getTime();
        return diff !== 0 ? diff : a.adminUserId < b.adminUserId ? -1 : 1;
      });
  }

  /** 倾斜模式：在有效条目中轮流挑选下一位承接人 */
  private async pickTiltAssignee(db: Db, plan: PlanRow): Promise<TiltCandidate | null> {
    const eligible = sortPlanItems(plan.items).filter(
      (item) => isItemEligible(item) && item.assignedCount < item.targetCount,
    );
    if (eligible.length === 0) return null;

    // 组内指针 = 本计划最近一次倾斜分配的承接人（不写额外状态，计划自身即状态）
    const last = await db.leadAssignment.findFirst({
      where: { planId: plan.id, source: LeadAssignmentSource.PRIORITY_PLAN },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { assigneeId: true },
    });

    let index = 0;
    if (last) {
      const pos = eligible.findIndex((item) => item.adminUserId === last.assigneeId);
      index = pos >= 0 ? (pos + 1) % eligible.length : 0;
    }
    return { item: eligible[index], index };
  }

  // ────────────────── 计划状态解析（惰性迁移） ──────────────────

  /**
   * 取「当前计划」：生效中 / 待生效（startAt 在未来）/ 冷却暂停中。
   * 同时完成两类惰性迁移，保证页面与引擎看到的状态一致：
   *   · 冷却期结束的已关闭计划 → 自动恢复为 ACTIVE
   *   · 已过 endAt 或全部条目达标的 ACTIVE 计划 → 自动完成
   */
  private async resolveCurrentPlan(db: Db, now: Date): Promise<PlanRow | null> {
    const rows = await db.leadDistributionPlan.findMany({
      where: {
        OR: [
          { status: LeadPlanStatus.ACTIVE },
          // 冷却暂停中（等待自动恢复）
          { status: LeadPlanStatus.CLOSED, resumeAt: { gt: now } },
          // 冷却已结束（SQL 中 NULL <= now 为假，天然排除「需手动恢复」的关闭计划）
          { status: LeadPlanStatus.CLOSED, resumeAt: { lte: now } },
        ],
      },
      include: PLAN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 3,
    });

    const row = rows[0];
    if (!row) return null;

    if (row.status === LeadPlanStatus.CLOSED) {
      if (row.resumeAt && row.resumeAt.getTime() <= now.getTime()) {
        return this.resumePlanInTx(db, row, 'cooldown_elapsed');
      }
      return row; // 冷却暂停中
    }

    if (row.startAt.getTime() > now.getTime()) return row; // 待生效
    if (row.endAt && row.endAt.getTime() <= now.getTime()) {
      return this.completePlanInTx(db, row, 'end_at_passed');
    }
    if (allItemsAtTarget(row.items)) {
      return this.completePlanInTx(db, row, 'targets_reached');
    }
    return row;
  }

  /** 计划自动 / 手动完成（status → COMPLETED） */
  private async completePlanInTx(
    db: Db,
    plan: PlanRow,
    reason: 'targets_reached' | 'end_at_passed',
  ): Promise<PlanRow> {
    const updated = await db.leadDistributionPlan.update({
      where: { id: plan.id },
      data: { status: LeadPlanStatus.COMPLETED, resumeAt: null },
      include: PLAN_INCLUDE,
    });
    await this.audit.record(
      {
        actor: null,
        action: 'lead_plan.complete',
        targetType: 'LeadDistributionPlan',
        targetId: plan.id,
        planId: plan.id,
        summary:
          reason === 'targets_reached'
            ? `倾斜计划「${plan.name}」全部员工达到目标数量，计划自动完成，询盘分配恢复为正常轮询`
            : `倾斜计划「${plan.name}」已过截止时间，计划自动完成，询盘分配恢复为正常轮询`,
        diff: { before: { status: plan.status }, after: { status: LeadPlanStatus.COMPLETED }, reason },
      },
      db,
    );
    return updated;
  }

  /** 冷却结束自动恢复 / 管理员手动恢复（status → ACTIVE） */
  private async resumePlanInTx(
    db: Db,
    plan: PlanRow,
    reason: 'cooldown_elapsed' | 'manual',
  ): Promise<PlanRow> {
    const updated = await db.leadDistributionPlan.update({
      where: { id: plan.id },
      data: {
        status: LeadPlanStatus.ACTIVE,
        resumeAt: null,
        closedAt: null,
        closedBy: null,
      },
      include: PLAN_INCLUDE,
    });
    await this.audit.record(
      {
        actor: null,
        action: 'lead_plan.resume',
        targetType: 'LeadDistributionPlan',
        targetId: plan.id,
        planId: plan.id,
        summary:
          reason === 'cooldown_elapsed'
            ? `倾斜计划「${plan.name}」冷却时间结束，自动恢复执行`
            : `倾斜计划「${plan.name}」被管理员手动恢复执行`,
        diff: {
          before: { status: plan.status, resumeAt: plan.resumeAt },
          after: { status: LeadPlanStatus.ACTIVE, resumeAt: null },
          reason,
        },
      },
      db,
    );
    return updated;
  }

  // ────────────────── 倾斜计划管理 ──────────────────

  /** 创建倾斜计划 */
  async createPlan(dto: CreatePlanDto, actor: ActorContext): Promise<CreatePlanResultDto> {
    const now = new Date();

    // 惰性迁移后再判断占用：已达标 / 已过期的 ACTIVE 计划不应挡住新建
    await this.resolveCurrentPlan(this.prisma, now);
    const blocking = await this.prisma.leadDistributionPlan.findFirst({
      where: {
        OR: [
          { status: LeadPlanStatus.ACTIVE },
          { status: LeadPlanStatus.CLOSED, resumeAt: { gt: now } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, status: true, resumeAt: true },
    });
    if (blocking) {
      if (blocking.status === LeadPlanStatus.CLOSED) {
        throw new BadRequestException(
          `倾斜计划「${blocking.name}」正在冷却暂停中` +
            `（${blocking.resumeAt ? new Date(blocking.resumeAt).toLocaleString('zh-CN') : ''} 自动恢复），` +
            '请等待其恢复执行或手动恢复/完成后再次创建。',
        );
      }
      throw new BadRequestException(
        `已存在生效中的倾斜计划「${blocking.name}」，同一时间只能有一个倾斜计划。`,
      );
    }

    const ids = dto.items.map((i) => i.adminUserId);
    this.assertNoDuplicateEmployees(ids);
    const employees = await this.loadPlanEmployees(ids);

    const startAt = parseDate(dto.startAt, 'startAt') ?? now;
    const endAt = parseDate(dto.endAt, 'endAt');
    if (endAt && endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('计划截止时间必须晚于生效时间');
    }

    const plan = await this.prisma.$transaction(async (tx) => {
      const created = await tx.leadDistributionPlan.create({
        data: {
          name: dto.name,
          mode: 'PRIORITY',
          startAt,
          endAt: endAt ?? null,
          cooldownSeconds: dto.cooldownSeconds ?? 0,
          totalTarget: dto.items.reduce((s, i) => s + i.targetCount, 0),
          createdBy: actor.id,
          items: {
            create: dto.items.map((item, index) => ({
              adminUserId: item.adminUserId,
              targetCount: item.targetCount,
              sortOrder: item.sortOrder ?? index,
            })),
          },
        },
        select: { id: true },
      });
      return created.id;
    });

    await this.audit.record({
      actor,
      action: 'lead_plan.create',
      targetType: 'LeadDistributionPlan',
      targetId: plan,
      planId: plan,
      summary: `创建倾斜计划「${dto.name}」，共 ${dto.items.length} 名员工、目标合计 ` +
        `${dto.items.reduce((s, i) => s + i.targetCount, 0)} 单` +
        `${endAt ? `，截止 ${endAt.toLocaleString('zh-CN')}` : ''}`,
      diff: {
        after: {
          name: dto.name,
          startAt,
          endAt: endAt ?? null,
          cooldownSeconds: dto.cooldownSeconds ?? 0,
          items: dto.items.map((i) => ({
            adminUserId: i.adminUserId,
            targetCount: i.targetCount,
          })),
        },
      },
    });

    this.logger.log(`创建倾斜计划「${dto.name}」 by ${actor.email}`);

    return {
      plan: await this.getPlan(plan),
      assigned: 0,
      // 已入库但当前不可分配的员工（账号停用 / 未标记为询盘联系人）
      skipped: dto.items
        .filter((i) => {
          const u = employees.get(i.adminUserId);
          return !u || !u.isActive || u.contact?.isLeadContact !== true;
        })
        .map((i) => i.adminUserId),
    };
  }

  /** 调整进行中计划的员工与目标（整表替换，保留已接单进度） */
  async updatePlan(id: string, dto: UpdatePlanDto, actor: ActorContext): Promise<PlanDto> {
    const plan = await this.prisma.leadDistributionPlan.findUnique({
      where: { id },
      include: PLAN_INCLUDE,
    });
    if (!plan) throw new NotFoundException('倾斜计划不存在');
    if (plan.status !== LeadPlanStatus.ACTIVE) {
      throw new BadRequestException('只有生效中的计划可以调整员工与目标数量');
    }

    const ids = dto.items.map((i) => i.adminUserId);
    this.assertNoDuplicateEmployees(ids);
    await this.loadPlanEmployees(ids); // 防幽灵员工

    const endAt = dto.endAt === null ? null : (parseDate(dto.endAt, 'endAt') ?? plan.endAt);
    if (endAt && endAt.getTime() <= plan.startAt.getTime()) {
      throw new BadRequestException('计划截止时间必须晚于生效时间');
    }

    // 已在计划中的员工：目标只能调大，不能低于已成功分配数量（历史不可回溯）
    const current = new Map(plan.items.map((i) => [i.adminUserId, i]));
    for (const item of dto.items) {
      const existing = current.get(item.adminUserId);
      if (existing && item.targetCount < existing.assignedCount) {
        throw new BadRequestException(
          `员工 ${existing.adminUser.email} 已成功承接 ${existing.assignedCount} 单，` +
            `目标数量不能低于已分配数量（当前提交 ${item.targetCount}）。`,
        );
      }
    }
    // 有接单记录的员工不允许移出计划（否则其进度从计划统计中消失）
    const removing = [...current.keys()].filter((uid) => !ids.includes(uid));
    for (const uid of removing) {
      const item = current.get(uid)!;
      if (item.assignedCount > 0) {
        throw new BadRequestException(
          `员工 ${item.adminUser.email} 已在本计划中承接 ${item.assignedCount} 单，不能移出计划；` +
            '可将其目标数量调大。',
        );
      }
    }

    const before = {
      name: plan.name,
      cooldownSeconds: plan.cooldownSeconds,
      endAt: plan.endAt,
      items: sortPlanItems(plan.items).map((i) => ({
        adminUserId: i.adminUserId,
        targetCount: i.targetCount,
        sortOrder: i.sortOrder,
      })),
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.leadDistributionPlan.update({
        where: { id },
        data: {
          name: dto.name ?? plan.name,
          cooldownSeconds: dto.cooldownSeconds ?? plan.cooldownSeconds,
          endAt,
          totalTarget: dto.items.reduce((s, i) => s + i.targetCount, 0),
        },
      });
      // 移除不再包含的条目
      if (removing.length > 0) {
        await tx.leadDistributionItem.deleteMany({ where: { planId: id, adminUserId: { in: removing } } });
      }
      // 逐条 upsert：保留 assignedCount
      for (const [index, item] of dto.items.entries()) {
        await tx.leadDistributionItem.upsert({
          where: { planId_adminUserId: { planId: id, adminUserId: item.adminUserId } },
          create: {
            planId: id,
            adminUserId: item.adminUserId,
            targetCount: item.targetCount,
            sortOrder: item.sortOrder ?? index,
          },
          update: {
            targetCount: item.targetCount,
            sortOrder: item.sortOrder ?? index,
          },
        });
      }
    });

    await this.audit.record({
      actor,
      action: 'lead_plan.update',
      targetType: 'LeadDistributionPlan',
      targetId: id,
      planId: id,
      summary: `调整倾斜计划「${plan.name}」的员工与目标数量`,
      diff: {
        before,
        after: {
          name: dto.name ?? plan.name,
          cooldownSeconds: dto.cooldownSeconds ?? plan.cooldownSeconds,
          endAt,
          items: dto.items.map((i, index) => ({
            adminUserId: i.adminUserId,
            targetCount: i.targetCount,
            sortOrder: i.sortOrder ?? index,
          })),
        },
      },
    });

    this.logger.log(`调整倾斜计划「${plan.name}」 by ${actor.email}`);
    return this.getPlan(id);
  }

  /** 手动关闭计划：立即恢复正常轮询；cooldownSeconds > 0 时到期自动恢复 */
  async closePlan(id: string, dto: ClosePlanDto, actor: ActorContext): Promise<PlanDto> {
    const plan = await this.prisma.leadDistributionPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('倾斜计划不存在');
    if (plan.status !== LeadPlanStatus.ACTIVE) {
      throw new BadRequestException(
        plan.status === LeadPlanStatus.CLOSED ? '计划已经是关闭状态' : '计划已完成，无法关闭',
      );
    }

    const now = new Date();
    const resumeAt =
      plan.cooldownSeconds > 0 ? new Date(now.getTime() + plan.cooldownSeconds * 1000) : null;

    await this.prisma.leadDistributionPlan.update({
      where: { id },
      data: {
        status: LeadPlanStatus.CLOSED,
        closedAt: now,
        resumeAt,
        closedBy: actor.id,
      },
    });

    await this.audit.record({
      actor,
      action: 'lead_plan.close',
      targetType: 'LeadDistributionPlan',
      targetId: id,
      planId: id,
      summary: `手动关闭倾斜计划「${plan.name}」，询盘分配立即恢复正常轮询` +
        `${resumeAt ? `；${plan.cooldownSeconds} 秒后（${resumeAt.toLocaleString('zh-CN')}）自动恢复执行` : '；需管理员手动恢复才能再次执行'}`,
      diff: {
        before: { status: plan.status, closedAt: plan.closedAt, resumeAt: plan.resumeAt },
        after: { status: LeadPlanStatus.CLOSED, closedAt: now, resumeAt },
        reason: dto.reason ?? null,
      },
    });

    this.logger.log(`关闭倾斜计划「${plan.name}」 by ${actor.email}`);
    return this.getPlan(id);
  }

  /** 手动恢复已关闭的计划（不等冷却结束） */
  async resumePlan(id: string, actor: ActorContext): Promise<PlanDto> {
    const plan = await this.prisma.leadDistributionPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('倾斜计划不存在');
    if (plan.status !== LeadPlanStatus.CLOSED) {
      throw new BadRequestException(
        plan.status === LeadPlanStatus.ACTIVE ? '计划正在执行中' : '计划已完成，无法恢复',
      );
    }

    const blocking = await this.prisma.leadDistributionPlan.findFirst({
      where: { status: LeadPlanStatus.ACTIVE, id: { not: id } },
      select: { id: true },
    });
    if (blocking) {
      throw new BadRequestException('已存在其他生效中的倾斜计划，请先完成或关闭该计划');
    }

    await this.prisma.leadDistributionPlan.update({
      where: { id },
      data: { status: LeadPlanStatus.ACTIVE, resumeAt: null, closedAt: null, closedBy: null },
    });

    await this.audit.record({
      actor,
      action: 'lead_plan.resume',
      targetType: 'LeadDistributionPlan',
      targetId: id,
      planId: id,
      summary: `手动恢复倾斜计划「${plan.name}」执行`,
      diff: {
        before: { status: plan.status, resumeAt: plan.resumeAt },
        after: { status: LeadPlanStatus.ACTIVE, resumeAt: null },
        reason: 'manual',
      },
    });

    this.logger.log(`恢复倾斜计划「${plan.name}」 by ${actor.email}`);
    return this.getPlan(id);
  }

  // ────────────────── 查询 ──────────────────

  /** 首页唯一数据源：模式 / 队列 / 下一位承接人 / 当前计划 / 最近分配 / 趋势 */
  async getState(): Promise<LeadDistributionStateDto> {
    const now = new Date();
    const plan = await this.resolveCurrentPlan(this.prisma, now);
    const [queue, pointer, totals, recent, totalAssigned, unassignedCount, recentDates] =
      await Promise.all([
        this.loadQueue(this.prisma),
        this.loadPointer(this.prisma),
        this.loadAssignedTotals(this.prisma),
        this.prisma.leadAssignment.findMany({
          take: RECENT_LIMIT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: ASSIGNMENT_INCLUDE,
        }),
        this.prisma.leadAssignment.count(),
        this.prisma.rfq.count({ where: { assigneeId: null } }),
        this.prisma.leadAssignment.findMany({
          where: { createdAt: { gte: daysAgo(DAILY_DAYS - 1) } },
          select: { createdAt: true },
        }),
      ]);

    const nextIndex = nextRoundRobinIndex(queue, pointer);
    const emails = plan ? await this.loadPlanEmails(plan) : new Map<string, string>();

    return {
      currentMode:
        plan && isPlanInEffect(plan, now) && hasTiltCapacity(plan)
          ? LeadAssignmentSource.PRIORITY_PLAN
          : LeadAssignmentSource.ROUND_ROBIN,
      queue: queue.map((member, index) => this.toQueueMember(member, index, totals)),
      queueLength: queue.length,
      nextAssignee:
        nextIndex === null
          ? null
          : {
              adminUserId: queue[nextIndex].adminUserId,
              name: queue[nextIndex].name,
              email: queue[nextIndex].email,
              index: nextIndex,
            },
      activePlan: plan ? this.toPlanDto(plan, emails, now) : null,
      recentAssignments: recent.map((row) => this.toAssignmentDto(row)),
      dailyStats: toDailyStats(
        recentDates.map((r) => r.createdAt),
        DAILY_DAYS,
      ),
      totalAssigned,
      unassignedCount,
    };
  }

  /** 单个计划详情（弹窗数据源，进度全部来自真实计数） */
  async getPlan(id: string): Promise<PlanDto> {
    const plan = await this.prisma.leadDistributionPlan.findUnique({
      where: { id },
      include: PLAN_INCLUDE,
    });
    if (!plan) throw new NotFoundException('倾斜计划不存在');
    const emails = await this.loadPlanEmails(plan);
    return this.toPlanDto(plan, emails, new Date());
  }

  /** 分页分配历史 */
  async listAssignments(query: ListAssignmentsQueryDto): Promise<PaginatedAssignmentsDto> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    let source: LeadAssignmentSource | undefined;
    if (query.source) {
      if (!Object.values(LeadAssignmentSource).includes(query.source as LeadAssignmentSource)) {
        throw new BadRequestException(
          `source 只能是 ${Object.values(LeadAssignmentSource).join(' / ')}`,
        );
      }
      source = query.source as LeadAssignmentSource;
    }

    const where: Prisma.LeadAssignmentWhereInput = {
      ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
      ...(source ? { source } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.leadAssignment.count({ where }),
      this.prisma.leadAssignment.findMany({
        where,
        include: ASSIGNMENT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map((row) => this.toAssignmentDto(row)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 计划操作历史（审计日志） */
  async listLogs(planId: string, query: ListPlanLogsQueryDto): Promise<PlanLogDto[]> {
    const plan = await this.prisma.leadDistributionPlan.findUnique({
      where: { id: planId },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException('倾斜计划不存在');
    const take = Math.min(200, Math.max(1, query.take ?? DEFAULT_LOG_TAKE));
    const logs = await this.audit.listForPlan(planId, take);
    return logs.map((log) => ({
      id: log.id,
      action: log.action,
      actorEmail: log.actorEmail,
      summary: log.summary,
      diff: log.diff,
      createdAt: log.createdAt,
    }));
  }

  /** 创建计划前的员工预检列表（含当前队列位置与是否已在计划中） */
  async listEligibleAssignees(): Promise<EligibleAssigneeDto[]> {
    const now = new Date();
    const [users, totals, queue, plan] = await Promise.all([
      this.prisma.adminUser.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          jobTitle: true,
          isActive: true,
          contact: { select: { isLeadContact: true } },
        },
        orderBy: [{ createdAt: 'asc' }],
      }),
      this.loadAssignedTotals(this.prisma),
      this.loadQueue(this.prisma),
      this.resolveCurrentPlan(this.prisma, now),
    ]);

    const queueIndex = new Map(queue.map((m) => [m.adminUserId, queue.indexOf(m)]));
    const planMembers = new Map(
      (plan?.items ?? []).map((item) => [
        item.adminUserId,
        item.targetCount - item.assignedCount,
      ]),
    );

    return users.map((u) => ({
      adminUserId: u.id,
      name: u.name,
      email: u.email,
      jobTitle: u.jobTitle,
      isActive: u.isActive,
      isLeadContact: u.contact?.isLeadContact === true,
      assignedTotal: totals.get(u.id) ?? 0,
      inActivePlan: planMembers.has(u.id),
      remainingInActivePlan: planMembers.get(u.id) ?? null,
      queueIndex: queueIndex.get(u.id) ?? -1,
    }));
  }

  // ────────────────── 内部工具 ──────────────────

  /** 防重复员工：DTO 的 @ArrayUnique 对对象数组无效（比的是引用），必须在服务层校验 */
  private assertNoDuplicateEmployees(ids: string[]): void {
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) duplicated.push(id);
      seen.add(id);
    }
    if (duplicated.length > 0) {
      throw new BadRequestException(
        `倾斜计划中存在重复员工：${[...new Set(duplicated)].join('、')}`,
      );
    }
  }

  /** 加载计划员工并校验真实性（防幽灵员工） */
  private async loadPlanEmployees(ids: string[]) {
    const users = await this.prisma.adminUser.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        contact: { select: { isLeadContact: true } },
      },
    });
    const map = new Map(users.map((u) => [u.id, u]));
    const missing = ids.filter((id) => !map.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `以下员工账号不存在，必须是系统中的真实员工：${missing.join('、')}`,
      );
    }
    return map;
  }

  /** 每人累计承接询盘数（真实计数） */
  private async loadAssignedTotals(db: Db): Promise<Map<string, number>> {
    const grouped = await db.leadAssignment.groupBy({
      by: ['assigneeId'],
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.assigneeId, g._count._all]));
  }

  /** 计划创建者 / 关闭者邮箱 */
  private async loadPlanEmails(plan: {
    createdBy: string | null;
    closedBy: string | null;
  }): Promise<Map<string, string>> {
    const ids = [plan.createdBy, plan.closedBy].filter((v): v is string => Boolean(v));
    if (ids.length === 0) return new Map();
    const users = await this.prisma.adminUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.email]));
  }

  private toQueueMember(
    member: QueueEmployee,
    index: number,
    totals: Map<string, number>,
  ): QueueMemberDto {
    return {
      adminUserId: member.adminUserId,
      name: member.name,
      email: member.email,
      isActive: true,
      index,
      assignedTotal: totals.get(member.adminUserId) ?? 0,
    };
  }

  private toPlanItemDto(item: PlanItemRow): PlanItemProgressDto {
    const remainingCount = Math.max(0, item.targetCount - item.assignedCount);
    return {
      adminUserId: item.adminUserId,
      name: item.adminUser.name,
      email: item.adminUser.email,
      jobTitle: item.adminUser.jobTitle,
      targetCount: item.targetCount,
      assignedCount: item.assignedCount,
      remainingCount,
      completionPercent:
        item.targetCount > 0
          ? Math.min(100, Math.round((item.assignedCount / item.targetCount) * 100))
          : 0,
      isEmployeeActive: item.adminUser.isActive,
      isEligible: isItemEligible(item),
      sortOrder: item.sortOrder,
    };
  }

  private toPlanDto(plan: PlanRow, emails: Map<string, string>, now: Date): PlanDto {
    const items = sortPlanItems(plan.items);
    const totalAssigned = items.reduce((s, i) => s + i.assignedCount, 0);
    const totalTarget = items.reduce((s, i) => s + i.targetCount, 0);
    const inEffect = isPlanInEffect(plan, now);
    return {
      id: plan.id,
      name: plan.name,
      status: plan.status,
      mode: plan.mode,
      startAt: plan.startAt,
      endAt: plan.endAt,
      totalTarget,
      totalAssigned,
      completionPercent:
        totalTarget > 0 ? Math.min(100, Math.round((totalAssigned / totalTarget) * 100)) : 0,
      cooldownSeconds: plan.cooldownSeconds,
      closedAt: plan.closedAt,
      resumeAt: plan.resumeAt,
      isCooldownElapsed:
        plan.resumeAt !== null && plan.resumeAt.getTime() <= now.getTime(),
      closedByEmail: plan.closedBy ? (emails.get(plan.closedBy) ?? null) : null,
      createdByEmail: plan.createdBy ? (emails.get(plan.createdBy) ?? null) : null,
      isInEffect: inEffect,
      /** 当前是否仍有可接单的倾斜员工（false = 全部停用或全部达标，实际已回落轮询） */
      hasTiltCapacity: hasTiltCapacity(plan),
      isPendingStart: plan.status === LeadPlanStatus.ACTIVE && !inEffect && plan.startAt > now,
      isPendingResume:
        plan.status === LeadPlanStatus.CLOSED &&
        plan.resumeAt !== null &&
        plan.resumeAt.getTime() > now.getTime(),
      items: items.map((item) => this.toPlanItemDto(item)),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  private toAssignmentDto(row: AssignmentRow): AssignmentDto {
    return {
      id: row.id,
      rfqId: row.rfqId,
      rfqSummary: {
        name: row.rfq.name,
        company: row.rfq.company,
        country: row.rfq.country,
        productName: row.rfq.productName,
        status: row.rfq.status,
      },
      assignee: {
        adminUserId: row.assignee.id,
        name: row.assignee.name,
        email: row.assignee.email,
      },
      source: row.source,
      roundRobinIndex: row.roundRobinIndex,
      planId: row.planId,
      planName: row.plan?.name ?? null,
      createdAt: row.createdAt,
    };
  }
}

/** 近 N 天每日分配量（本地日期分桶，避免数据库时区歧义） */
function toDailyStats(dates: Date[], days: number): { date: string; count: number }[] {
  const buckets = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    buckets.set(dateKey(d), 0);
  }
  for (const d of dates) {
    const key = dateKey(d);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count })).reverse();
}

function parseDate(
  value: string | undefined | null,
  field: string,
): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} 时间格式不正确：${value}`);
  }
  return parsed;
}

