import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../rbac/audit-log.service';
import type { ActorContext } from '../../rbac/actor-context';
import { ListContactsQueryDto, UpsertContactDto } from './dto/contact.dto';
import type { ContactDto, ContactListDto, PublicContactDto } from './entities/contact.entity';

/** 联系方式必须关联的查询片段（防幽灵员工：只允许真实存在的员工） */
const CONTACT_INCLUDE = {
  adminUser: {
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
    },
  },
} satisfies Prisma.EmployeeContactInclude;

/**
 * 员工联系方式服务（Phase 4.6）。
 *
 * 硬约束（规格逐条落地）：
 *   1. **必须关联真实员工账号**：adminUserId 对应的 AdminUser 必须存在，否则 400
 *      （前端可在下拉里只列员工，但后端不信任客户端提交的 ID）
 *   2. **登录邮箱 ≠ 展示邮箱**：displayEmail 任意可设，对外使用展示邮箱
 *   3. **WhatsApp 国际号码**：归一化 + E.164 校验由 DTO 完成，本服务拒绝再存脏值
 *   4. **内部备注不进公开接口**：公开查询只 select 展示字段
 *   5. **停用员工自动停止公开展示**：账号停用时由 AccountsService 同步把 showOnSite 置 false；
 *      **重新启用不自动恢复展示**（规格明确要求）——必须由操作人显式重新开启
 *   6. 每个员工一条联系方式（adminUserId @unique）；多员工 = 多条独立记录
 *   7. 全部写操作落审计日志
 */
@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** 后台列表：联系方式 + 未绑定员工 */
  async list(query: ListContactsQueryDto): Promise<ContactListDto> {
    const keyword = query.keyword?.trim();

    const where: Prisma.EmployeeContactWhereInput = {
      ...(query.isLeadContact !== undefined ? { isLeadContact: query.isLeadContact } : {}),
      ...(query.showOnSite !== undefined ? { showOnSite: query.showOnSite } : {}),
      ...(keyword
        ? {
            OR: [
              { displayName: { contains: keyword, mode: 'insensitive' } },
              { jobTitle: { contains: keyword, mode: 'insensitive' } },
              { adminUser: { name: { contains: keyword, mode: 'insensitive' } } },
              { adminUser: { email: { contains: keyword, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const contacts = await this.prisma.employeeContact.findMany({
      where,
      include: CONTACT_INCLUDE,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    // 未绑定联系方式的员工（仅展示启用中的账号，避免列表噪音）
    const boundIds = new Set(contacts.map((c) => c.adminUserId));
    const employeesWithoutContact = await this.prisma.adminUser.findMany({
      where: { isActive: true, id: { notIn: [...boundIds] } },
      select: { id: true, name: true, email: true, jobTitle: true },
      orderBy: [{ jobTitle: 'asc' }, { email: 'asc' }],
    });

    return {
      items: contacts.map((c) => this.toDto(c)),
      total: contacts.length,
      employeesWithoutContact: query.withoutContactOnly
        ? employeesWithoutContact
        : employeesWithoutContact.slice(0, 20),
    };
  }

  /** 详情 */
  async findById(id: string): Promise<ContactDto> {
    const contact = await this.prisma.employeeContact.findUnique({
      where: { id },
      include: CONTACT_INCLUDE,
    });
    if (!contact) throw new NotFoundException('联系方式不存在');
    return this.toDto(contact);
  }

  /** 按员工账号 id 查联系方式（存在则返回，否则 404） */
  async findByAdminUser(adminUserId: string): Promise<ContactDto> {
    const contact = await this.prisma.employeeContact.findUnique({
      where: { adminUserId },
      include: CONTACT_INCLUDE,
    });
    if (!contact) throw new NotFoundException('该员工尚未绑定联系方式');
    return this.toDto(contact);
  }

  /**
   * 创建或更新某员工的联系方式（按 adminUserId 唯一，PUT 语义）。
   *
   * 提权/安全校验：
   *   · adminUserId 必须对应真实存在的员工账号（防幽灵员工）
   *   · WhatsApp 已由 DTO 归一化
   */
  async upsert(dto: UpsertContactDto, actor: ActorContext): Promise<ContactDto> {
    const employee = await this.prisma.adminUser.findUnique({
      where: { id: dto.adminUserId },
      select: { id: true, name: true, email: true, isActive: true },
    });
    if (!employee) {
      throw new BadRequestException(
        `员工账号不存在（${dto.adminUserId}），必须关联系统中的真实员工，不能创建幽灵员工。`,
      );
    }

    const existing = await this.prisma.employeeContact.findUnique({
      where: { adminUserId: dto.adminUserId },
      select: { id: true },
    });

    const data = {
      displayName: dto.displayName.trim(),
      jobTitle: dto.jobTitle?.trim() || null,
      displayEmail: dto.displayEmail?.trim().toLowerCase() || null,
      whatsapp: dto.whatsapp?.trim() || null,
      showOnSite: dto.showOnSite ?? false,
      isLeadContact: dto.isLeadContact ?? false,
      sortOrder: Number.isFinite(dto.sortOrder) ? Math.floor(dto.sortOrder as number) : 100,
      internalNote: dto.internalNote?.trim() || null,
    };

    const contact = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.employeeContact.update({ where: { id: existing.id }, data });
        return existing.id;
      }
      const created = await tx.employeeContact.create({
        data: { ...data, adminUserId: dto.adminUserId },
        select: { id: true },
      });
      return created.id;
    });

    await this.audit.record({
      actor,
      action: existing ? 'contacts.update' : 'contacts.create',
      targetType: 'EmployeeContact',
      targetId: contact,
      summary: `${existing ? '更新' : '创建'}员工「${data.displayName}」的联系方式` +
        `（展示：${data.showOnSite ? '开' : '关'}，询盘联系人：${data.isLeadContact ? '是' : '否'}）`,
      diff: existing
        ? { after: { displayName: data.displayName, showOnSite: data.showOnSite, isLeadContact: data.isLeadContact } }
        : { before: null, after: { displayName: data.displayName, adminUserId: dto.adminUserId } },
    });

    this.logger.log(
      `员工联系方式${existing ? '更新' : '创建'}: ${employee.email} by ${actor.email}`,
    );
    return this.findById(contact);
  }

  /**
   * 切换公开展示开关。
   * 独立于 upsert：规格要求「展示开关」与「编辑联系方式」可分开操作。
   * 注意：**停用账号导致的自动不展示，不会因启用账号而自动恢复**——
   * 只有显式调用本接口或重新 upsert 才会改变 showOnSite。
   */
  async setShowOnSite(id: string, showOnSite: boolean, actor: ActorContext): Promise<ContactDto> {
    const contact = await this.prisma.employeeContact.findUnique({
      where: { id },
      select: { id: true, displayName: true, showOnSite: true },
    });
    if (!contact) throw new NotFoundException('联系方式不存在');

    if (contact.showOnSite === showOnSite) return this.findById(id);

    await this.prisma.employeeContact.update({ where: { id }, data: { showOnSite } });

    await this.audit.record({
      actor,
      action: 'contacts.toggle_public',
      targetType: 'EmployeeContact',
      targetId: id,
      summary: `将员工「${contact.displayName}」的联系方式公开展示设为${showOnSite ? '开启' : '关闭'}`,
      diff: { before: { showOnSite: contact.showOnSite }, after: { showOnSite } },
    });

    return this.findById(id);
  }

  /**
   * 删除联系方式。
   * 说明：规格未强制要求删除，但为「员工离职后清理」提供能力。
   * 只删联系方式本身，**不动员工账号**，也不动历史询盘归属。
   */
  async remove(id: string, actor: ActorContext): Promise<{ id: string }> {
    const contact = await this.prisma.employeeContact.findUnique({
      where: { id },
      select: { id: true, displayName: true, adminUserId: true },
    });
    if (!contact) throw new NotFoundException('联系方式不存在');

    await this.prisma.employeeContact.delete({ where: { id } });

    await this.audit.record({
      actor,
      action: 'contacts.delete',
      targetType: 'EmployeeContact',
      targetId: id,
      summary: `删除员工「${contact.displayName}」的联系方式（员工账号保留）`,
      diff: { before: { displayName: contact.displayName, adminUserId: contact.adminUserId } },
    });

    return { id };
  }

  /**
   * 公开只读列表（供前台后续消费）。
   *
   * 硬约束（规格 + 数据诚实）：
   *   · **只返回** showOnSite=true **且** 员工账号启用中的联系方式
   *   · **绝不返回** internalNote、adminUserId、登录邮箱
   *   · 停用员工即使 showOnSite 尚为 true 也不会出现（账号停用时已同步关闭，
   *     此处仍按实时 isActive 再过滤一次，双保险）
   */
  async listPublic(): Promise<PublicContactDto[]> {
    const rows = await this.prisma.employeeContact.findMany({
      where: {
        showOnSite: true,
        adminUser: { isActive: true },
      },
      select: {
        displayName: true,
        jobTitle: true,
        displayEmail: true,
        whatsapp: true,
        sortOrder: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map((r) => ({
      displayName: r.displayName,
      jobTitle: r.jobTitle,
      displayEmail: r.displayEmail,
      whatsapp: r.whatsapp,
      sortOrder: r.sortOrder,
    }));
  }

  // ── 内部 ────────────────────────────────────────────────────

  private toDto(contact: {
    id: string;
    adminUserId: string;
    displayName: string;
    jobTitle: string | null;
    displayEmail: string | null;
    whatsapp: string | null;
    showOnSite: boolean;
    isLeadContact: boolean;
    sortOrder: number;
    internalNote: string | null;
    createdAt: Date;
    updatedAt: Date;
    adminUser: { id: string; name: string | null; email: string; isActive: boolean };
  }): ContactDto {
    return {
      id: contact.id,
      adminUserId: contact.adminUserId,
      displayName: contact.displayName,
      jobTitle: contact.jobTitle,
      displayEmail: contact.displayEmail,
      whatsapp: contact.whatsapp,
      showOnSite: contact.showOnSite,
      isLeadContact: contact.isLeadContact,
      sortOrder: contact.sortOrder,
      internalNote: contact.internalNote,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      employee: {
        id: contact.adminUser.id,
        name: contact.adminUser.name,
        email: contact.adminUser.email,
        loginEmail: contact.adminUser.email,
        isActive: contact.adminUser.isActive,
      },
    };
  }
}
