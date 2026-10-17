import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SampleRequestStatus, SampleStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../rbac/audit-log.service';
import { RbacService } from '../rbac/rbac.service';
import type { ActorContext } from '../rbac/actor-context';
import type { AuthUser } from '../auth/auth.types';
import {
  CreateSampleDto,
  CreateSampleRequestDto,
  DecideSampleRequestDto,
  GrantSamplesDto,
  ListSampleRequestsQueryDto,
  ListSamplesQueryDto,
  UpdateSampleDto,
} from './dto/samples.dto';
import type {
  Paginated,
  SampleDetailDto,
  SampleDto,
  SampleRequestDto,
} from './entities/sample.entity';

const OWNER_INCLUDE = {
  owner: { select: { name: true, email: true } },
} satisfies Prisma.SampleInclude;

/**
 * 样品管理服务（Phase 5.1）。
 *
 * 权限模型：
 *   · 管理员 = isSuperAdmin 或持有 samples.manage 权限 → 可见全部样品、管理授权、查看归档
 *   · 普通业务员 → 仅可见自己持有的样品与被授权查看的样品
 *   · 出库申请的创建/撤回/审批不做独立权限 key，由服务层按业务身份判定：
 *       创建 = 持有人或被授权人；撤回 = 申请人本人；审批 = 仅样品持有人（禁止自批）。
 */
@Injectable()
export class SamplesService {
  private readonly logger = new Logger(SamplesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly audit: AuditLogService,
  ) {}

  /** 从会话用户解析操作人上下文（实时权限） */
  async getActor(user: AuthUser): Promise<ActorContext> {
    const access = await this.rbac.resolveAccess(user.id);
    if (!access.isActive) {
      throw new ForbiddenException('账号已停用');
    }
    return {
      id: user.id,
      email: access.email,
      name: access.name,
      permissions: access.permissions,
      isSuperAdmin: access.isSuperAdmin,
    };
  }

  isAdmin(actor: ActorContext): boolean {
    return actor.isSuperAdmin || actor.permissions.has('samples.manage');
  }

  /* ------------------------------ 样品 CRUD ------------------------------ */

  async list(actor: ActorContext, query: ListSamplesQueryDto): Promise<Paginated<SampleDto>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const admin = this.isAdmin(actor);

    const where: Prisma.SampleWhereInput = {
      status: { not: SampleStatus.OUT },
    };
    if (query.status) where.status = query.status;
    if (query.keyword) {
      where.AND = [
        {
          OR: [
            { name: { contains: query.keyword, mode: 'insensitive' } },
            { code: { contains: query.keyword, mode: 'insensitive' } },
            { spec: { contains: query.keyword, mode: 'insensitive' } },
          ],
        },
      ];
    }
    if (admin) {
      if (query.ownerId) where.ownerId = query.ownerId;
    } else {
      where.OR = [
        { ownerId: actor.id },
        { grants: { some: { granteeId: actor.id, revokedAt: null } } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.sample.count({ where }),
      this.prisma.sample.findMany({
        where,
        include: OWNER_INCLUDE,
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

  /** 归档历史（已出库样品，仅管理员） */
  async listArchive(actor: ActorContext, query: ListSamplesQueryDto): Promise<Paginated<SampleDto>> {
    if (!this.isAdmin(actor)) {
      throw new ForbiddenException('仅管理员可查看出库归档历史');
    }
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const where: Prisma.SampleWhereInput = { status: SampleStatus.OUT };
    if (query.keyword) {
      where.OR = [
        { name: { contains: query.keyword, mode: 'insensitive' } },
        { code: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.sample.count({ where }),
      this.prisma.sample.findMany({
        where,
        include: OWNER_INCLUDE,
        orderBy: [{ archivedAt: 'desc' }, { id: 'asc' }],
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

  async detail(actor: ActorContext, id: string): Promise<SampleDetailDto> {
    const sample = await this.prisma.sample.findUnique({
      where: { id },
      include: {
        ...OWNER_INCLUDE,
        grants: {
          where: { revokedAt: null },
          include: { grantee: { select: { name: true, email: true } } },
        },
        requests: {
          where: { status: SampleRequestStatus.PENDING },
          include: { requester: { select: { name: true, email: true } } },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!sample) throw new NotFoundException('样品不存在');

    const admin = this.isAdmin(actor);
    // 已出库归档样品：业务接口一律不可见，仅管理员走归档历史接口
    if (sample.status === SampleStatus.OUT && !admin) {
      throw new NotFoundException('样品不存在');
    }
    const isOwner = sample.ownerId === actor.id;
    const granted = sample.grants.some((g) => g.granteeId === actor.id);
    if (!admin && !isOwner && !granted) {
      // 与「未授权业务员不能访问样品详情」对应；不泄漏存在性
      throw new NotFoundException('样品不存在');
    }

    const pending = sample.requests[0];
    return {
      ...this.toDto(sample),
      grants: sample.grants.map((g) => ({
        id: g.id,
        granteeId: g.granteeId,
        granteeName: g.grantee.name,
        grantedById: g.grantedById,
        createdAt: g.createdAt,
      })),
      pendingRequest: pending
        ? {
            id: pending.id,
            requesterId: pending.requesterId,
            requesterName: pending.requester.name,
            purpose: pending.purpose,
            createdAt: pending.createdAt,
          }
        : null,
    };
  }

  async create(actor: ActorContext, dto: CreateSampleDto): Promise<SampleDto> {
    // 持有人 = 当前登录用户（后端确定，不信任前端）
    let created;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        created = await this.prisma.sample.create({
          data: {
            code: this.generateCode('SP'),
            name: dto.name,
            spec: dto.spec ?? null,
            material: dto.material ?? null,
            usage: dto.usage ?? null,
            quantity: dto.quantity,
            unit: dto.unit,
            location: dto.location,
            remark: dto.remark ?? null,
            ownerId: actor.id,
          },
          include: OWNER_INCLUDE,
        });
        break;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          if (attempt === 4) throw new ConflictException('样品编号生成冲突，请重试');
          continue;
        }
        throw error;
      }
    }
    await this.audit.record({
      actor,
      action: 'sample.create',
      targetType: 'sample',
      targetId: created!.id,
      summary: `录入样品 ${created!.code}（${created!.name}）`,
      diff: { after: { ...dto } },
    });
    return this.toDto(created!);
  }

  async update(actor: ActorContext, id: string, dto: UpdateSampleDto): Promise<SampleDto> {
    const sample = await this.prisma.sample.findUnique({ where: { id } });
    if (!sample) throw new NotFoundException('样品不存在');
    if (sample.status === SampleStatus.OUT) {
      throw new BadRequestException('样品已出库归档，不能再编辑');
    }
    const admin = this.isAdmin(actor);
    if (!admin && sample.ownerId !== actor.id) {
      throw new ForbiddenException('只能编辑自己持有的样品');
    }

    const updated = await this.prisma.sample.update({
      where: { id },
      data: {
        name: dto.name,
        spec: dto.spec,
        material: dto.material,
        usage: dto.usage,
        quantity: dto.quantity,
        unit: dto.unit,
        location: dto.location,
        remark: dto.remark,
      },
      include: OWNER_INCLUDE,
    });
    await this.audit.record({
      actor,
      action: 'sample.update',
      targetType: 'sample',
      targetId: id,
      summary: `编辑样品 ${sample.code}`,
      diff: { before: { ...dto }, note: '仅记录提交字段' },
    });
    return this.toDto(updated);
  }

  /* ------------------------------ 授权 ------------------------------ */

  async grant(actor: ActorContext, sampleId: string, dto: GrantSamplesDto) {
    if (!this.isAdmin(actor)) {
      throw new ForbiddenException('仅管理员可以授权样品查看权限');
    }
    const sample = await this.prisma.sample.findUnique({ where: { id: sampleId } });
    if (!sample) throw new NotFoundException('样品不存在');
    if (sample.status === SampleStatus.OUT) {
      throw new BadRequestException('样品已出库归档，不能再授权');
    }

    const users = await this.prisma.adminUser.findMany({
      where: { id: { in: dto.userIds }, isActive: true },
      select: { id: true, name: true },
    });
    const validIds = new Set(users.map((u) => u.id));
    const invalid = dto.userIds.filter((uid) => !validIds.has(uid));
    if (invalid.length > 0) {
      throw new BadRequestException('存在无效或已停用的被授权人');
    }
    // 持有人天然可见，跳过
    const targets = dto.userIds.filter((uid) => uid !== sample.ownerId);

    const results = await this.prisma.$transaction(async (tx) => {
      const rows = [];
      for (const granteeId of targets) {
        // 幂等：已有有效授权则跳过；历史已撤销授权新建一条
        const active = await tx.sampleGrant.findFirst({
          where: { sampleId, granteeId, revokedAt: null },
        });
        if (active) continue;
        rows.push(
          await tx.sampleGrant.create({
            data: { sampleId, granteeId, grantedById: actor.id },
          }),
        );
      }
      return rows;
    });

    await this.audit.record({
      actor,
      action: 'sample.grant',
      targetType: 'sample',
      targetId: sampleId,
      summary: `授权 ${results.length} 名业务员查看样品 ${sample.code}`,
      diff: { userIds: targets },
    });
    return { granted: results.length, skipped: dto.userIds.length - results.length };
  }

  async revokeGrant(actor: ActorContext, sampleId: string, granteeId: string) {
    if (!this.isAdmin(actor)) {
      throw new ForbiddenException('仅管理员可以撤销样品授权');
    }
    const active = await this.prisma.sampleGrant.findFirst({
      where: { sampleId, granteeId, revokedAt: null },
      include: { sample: { select: { code: true, ownerId: true } } },
    });
    if (!active) throw new NotFoundException('该用户没有对样品的有效授权');
    if (granteeId === active.sample.ownerId) {
      // 撤销授权不影响持有人权限——持有人权限不来自授权记录，此分支理论不可达，防御性保留
      throw new BadRequestException('持有人权限不来自授权，无需撤销');
    }

    await this.prisma.sampleGrant.update({
      where: { id: active.id },
      data: { revokedAt: new Date(), revokedById: actor.id },
    });
    await this.audit.record({
      actor,
      action: 'sample.grant.revoke',
      targetType: 'sample',
      targetId: sampleId,
      summary: `撤销业务员对样品 ${active.sample.code} 的查看授权`,
      diff: { granteeId },
    });
    return { id: active.id };
  }

  /* ------------------------------ 出库申请 ------------------------------ */

  async createRequest(actor: ActorContext, sampleId: string, dto: CreateSampleRequestDto) {
    const sample = await this.prisma.sample.findUnique({
      where: { id: sampleId },
      include: {
        grants: { where: { granteeId: actor.id, revokedAt: null }, select: { id: true } },
      },
    });
    if (!sample) throw new NotFoundException('样品不存在');
    if (sample.status === SampleStatus.OUT) {
      // 已出库归档：对非管理员不可见（不泄漏存在性）
      throw new NotFoundException('样品不存在');
    }
    if (sample.status === SampleStatus.REQUEST_OUT) {
      throw new ConflictException('该样品已有待审批的出库申请');
    }
    const isOwner = sample.ownerId === actor.id;
    const granted = sample.grants.length > 0;
    if (!isOwner && !granted) {
      throw new ForbiddenException('只能对自己持有或被授权查看的样品申请出库');
    }

    const request = await this.prisma.$transaction(async (tx) => {
      // 部分唯一索引兜底并发重复申请（P2002 → 409）
      const created = await tx.sampleRequest.create({
        data: {
          sampleId,
          requesterId: actor.id,
          ownerId: sample.ownerId,
          purpose: dto.purpose,
        },
      });
      // 条件更新：仅 IN_STOCK / REJECTED 可进入 REQUEST_OUT
      const moved = await tx.sample.updateMany({
        where: { id: sampleId, status: { in: [SampleStatus.IN_STOCK, SampleStatus.REJECTED] } },
        data: { status: SampleStatus.REQUEST_OUT },
      });
      if (moved.count !== 1) {
        throw new ConflictException('样品当前状态不允许发起出库申请，请刷新后重试');
      }
      return created;
    });

    await this.audit.record({
      actor,
      action: 'sample.request.create',
      targetType: 'sample_request',
      targetId: request.id,
      summary: `申请出库样品 ${sample.code}`,
      diff: { purpose: dto.purpose },
    });
    return { id: request.id };
  }

  async withdrawRequest(actor: ActorContext, requestId: string) {
    const request = await this.prisma.sampleRequest.findUnique({
      where: { id: requestId },
      include: { sample: { select: { id: true, code: true } } },
    });
    if (!request) throw new NotFoundException('出库申请不存在');
    if (request.requesterId !== actor.id) {
      throw new ForbiddenException('只有申请人本人可以撤回申请');
    }
    if (request.status !== SampleRequestStatus.PENDING) {
      throw new ConflictException('该申请已处理完毕，不能撤回');
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.sampleRequest.updateMany({
        where: { id: requestId, status: SampleRequestStatus.PENDING },
        data: { status: SampleRequestStatus.WITHDRAWN, withdrawnAt: new Date() },
      });
      if (updated.count !== 1) {
        throw new ConflictException('申请状态已变化，撤回失败，请刷新后重试');
      }
      await tx.sample.updateMany({
        where: { id: request.sampleId, status: SampleStatus.REQUEST_OUT },
        data: { status: SampleStatus.IN_STOCK },
      });
    });
    await this.audit.record({
      actor,
      action: 'sample.request.withdraw',
      targetType: 'sample_request',
      targetId: requestId,
      summary: `撤回样品 ${request.sample.code} 的出库申请`,
    });
    return { id: requestId };
  }

  /** 持有人审批（同意 = 归档出库；拒绝 = 回到库中） */
  async decideRequest(actor: ActorContext, requestId: string, dto: DecideSampleRequestDto) {
    const request = await this.prisma.sampleRequest.findUnique({
      where: { id: requestId },
      include: { sample: { select: { id: true, code: true, name: true } } },
    });
    if (!request) throw new NotFoundException('出库申请不存在');
    if (request.status !== SampleRequestStatus.PENDING) {
      throw new ConflictException('该申请已处理（撤回 / 拒绝 / 同意），不能重复处理');
    }
    if (request.ownerId !== actor.id) {
      throw new ForbiddenException('只有样品持有人可以审批该申请');
    }
    if (request.requesterId === actor.id) {
      // 防自批：即使持有人自己发起申请，也必须由其他持有人场景外审批（本业务下即不可批）
      throw new ForbiddenException('申请人不能审批自己发起的出库申请');
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.sampleRequest.updateMany({
        where: { id: requestId, status: SampleRequestStatus.PENDING },
        data: {
          status: dto.decision === 'APPROVE' ? SampleRequestStatus.APPROVED : SampleRequestStatus.REJECTED,
          decidedById: actor.id,
          decidedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('申请状态已变化，审批失败，请刷新后重试');
      }
      if (dto.decision === 'APPROVE') {
        const archived = await tx.sample.updateMany({
          where: { id: request.sampleId, status: SampleStatus.REQUEST_OUT },
          data: { status: SampleStatus.OUT, archivedAt: new Date() },
        });
        if (archived.count !== 1) {
          throw new ConflictException('样品状态已变化，审批失败，请刷新后重试');
        }
      } else {
        await tx.sample.updateMany({
          where: { id: request.sampleId, status: SampleStatus.REQUEST_OUT },
          data: { status: SampleStatus.REJECTED },
        });
      }
    });
    await this.audit.record({
      actor,
      action: dto.decision === 'APPROVE' ? 'sample.request.approve' : 'sample.request.reject',
      targetType: 'sample_request',
      targetId: requestId,
      summary:
        dto.decision === 'APPROVE'
          ? `同意出库样品 ${request.sample.code}（已归档）`
          : `拒绝样品 ${request.sample.code} 的出库申请`,
      diff: { decision: dto.decision, requesterId: request.requesterId },
    });
    return { id: requestId, decision: dto.decision };
  }

  async listRequests(
    actor: ActorContext,
    query: ListSampleRequestsQueryDto,
  ): Promise<Paginated<SampleRequestDto>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const admin = this.isAdmin(actor);

    const where: Prisma.SampleRequestWhereInput = {};
    if (query.scope === 'pending') {
      where.ownerId = actor.id;
      where.status = SampleRequestStatus.PENDING;
    } else if (query.scope === 'mine') {
      where.requesterId = actor.id;
    } else {
      if (!admin) throw new ForbiddenException('仅管理员可查看全部申请');
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.sampleRequest.count({ where }),
      this.prisma.sampleRequest.findMany({
        where,
        include: {
          sample: {
            select: { code: true, name: true, owner: { select: { name: true, email: true } } },
          },
          requester: { select: { name: true, email: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map((row) => this.toRequestDto(row)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 样品操作历史（详情页 / 归档追溯） */
  async listLogs(actor: ActorContext, sampleId: string) {
    const sample = await this.prisma.sample.findUnique({ where: { id: sampleId } });
    if (!sample) throw new NotFoundException('样品不存在');
    // 出库归档历史仅管理员可追溯
    if (sample.status === SampleStatus.OUT && !this.isAdmin(actor)) {
      throw new NotFoundException('样品不存在');
    }
    const admin = this.isAdmin(actor);
    if (!admin && sample.ownerId !== actor.id) {
      const granted = await this.prisma.sampleGrant.findFirst({
        where: { sampleId, granteeId: actor.id, revokedAt: null },
      });
      if (!granted) throw new NotFoundException('样品不存在');
    }
    return this.audit.listForTarget('sample', sampleId, 100);
  }

  /* ------------------------------ 内部 ------------------------------ */

  private generateCode(prefix: string): string {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    const rand = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    return `${prefix}-${ymd}-${rand}`;
  }

  private toDto(sample: {
    id: string;
    code: string;
    name: string;
    spec: string | null;
    material: string | null;
    usage: string | null;
    quantity: number;
    unit: string;
    location: string;
    remark: string | null;
    status: SampleStatus;
    ownerId: string;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    owner: { name: string | null; email: string | null };
  }): SampleDto {
    return {
      id: sample.id,
      code: sample.code,
      name: sample.name,
      spec: sample.spec,
      material: sample.material,
      usage: sample.usage,
      quantity: sample.quantity,
      unit: sample.unit,
      location: sample.location,
      remark: sample.remark,
      status: sample.status,
      ownerId: sample.ownerId,
      ownerName: sample.owner.name,
      archivedAt: sample.archivedAt,
      createdAt: sample.createdAt,
      updatedAt: sample.updatedAt,
    };
  }

  private toRequestDto(row: {
    id: string;
    sampleId: string;
    requesterId: string;
    ownerId: string;
    purpose: string;
    status: SampleRequestStatus;
    decidedById: string | null;
    decidedAt: Date | null;
    withdrawnAt: Date | null;
    createdAt: Date;
    sample: { code: string; name: string; owner: { name: string | null } };
    requester: { name: string | null };
  }): SampleRequestDto {
    return {
      id: row.id,
      sampleId: row.sampleId,
      sampleCode: row.sample.code,
      sampleName: row.sample.name,
      requesterId: row.requesterId,
      requesterName: row.requester.name,
      ownerId: row.ownerId,
      ownerName: row.sample.owner.name,
      purpose: row.purpose,
      status: row.status,
      decidedById: row.decidedById,
      decidedAt: row.decidedAt,
      withdrawnAt: row.withdrawnAt,
      createdAt: row.createdAt,
    };
  }
}
