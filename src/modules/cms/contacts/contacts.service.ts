import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../revalidation/revalidation.service';
import { CmsTags } from '../../revalidation/cms-tags';
import { AuditLogService } from '../../rbac/audit-log.service';
import type { ActorContext } from '../../rbac/actor-context';
import { ListContactsQueryDto, UpsertContactDto } from './dto/contact.dto';
import type { ContactDto, ContactListDto, PublicContactDto } from './entities/contact.entity';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../media/storage/storage.interface';
import {
  ALLOWED_IMAGE_MIME,
  validateUpload,
  verifyImageSignature,
} from '../../media/media-file.util';

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
 *   3. **WhatsApp / 手机号国际号码**：归一化 + E.164 校验由 DTO 完成，本服务拒绝再存脏值
 *   4. **内部备注不进公开接口**：公开查询只 select 展示字段
 *   5. **停用员工自动停止公开展示**：账号停用时由 AccountsService 同步把 showOnSite 置 false；
 *      **重新启用不自动恢复展示**（规格明确要求）——必须由操作人显式重新开启
 *   6. 每个员工一条联系方式（adminUserId @unique）；多员工 = 多条独立记录
 *   7. 全部写操作落审计日志
 *
 * 头像（Phase 5.4 追加）：
 *   业务自己持 avatarKey + avatarUrl，委托 StorageProvider 落地（Local / COS 透明切换）。
 *   之所以不走 MediaAsset 外键：替换头像时必须**强制删除旧对象**，
 *   而 MediaAsset 有引用检查（MediaService.remove 会 400），头像不适合那套语义。
 */
@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly revalidation: RevalidationService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * 公开联系方式变更后通知前台失效（Phase 4.8）。
   *
   * 前台对 /public/contacts 采用 no-store（实时敏感内容），因此**即使不通知**
   * 下一次访问也已是新数据；这里额外通知是为了双保险，并覆盖
   * 「未来若将联系方式改为 ISR」的情形。
   */
  private notifyFrontend(): void {
    void this.revalidation.invalidate({
      tags: [CmsTags.contacts],
      paths: ['/contact'],
    });
  }

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
      phone: dto.phone?.trim() || null,
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
    this.notifyFrontend();
    return this.findById(contact);
  }

  /**
   * 上传 / 替换员工头像（每个员工一条，按 contactId 定位）。
   *
   * 时序设计（与需求「把原有头像删除再新增」等价，但更安全）：
   *   1. 先上传新对象到 StorageProvider（Local / COS 透明）
   *   2. 再把新 key/url 落库
   *   3. 最后删除旧对象
   *
   * 为什么不「先删旧再传新」：若上传在第 2 步失败，旧头像已被删 → 员工直接没有头像。
   * 采用「先传后删」后，上传失败时旧头像完好；且只要走到第 3 步，旧对象一定被清掉，
   * 存储中不会残留孤儿文件——需求要的「不留孤儿」完全满足。
   *
   * 校验与媒体库同一套：MIME 白名单 + 大小上限 + 内容魔数校验（防伪造扩展名）。
   *
   * 头像比媒体库**更严**：只接受图片（JPEG/PNG/WebP/AVIF）。
   * 媒体库白名单里含 PDF（Phase 4.5 质量证书需要），但 PDF 不能当头像，
   * 必须先按 ALLOWED_IMAGE_MIME 单独拦一道。
   */
  async setAvatar(id: string, file: Express.Multer.File, actor: ActorContext): Promise<ContactDto> {
    const contact = await this.prisma.employeeContact.findUnique({
      where: { id },
      select: { id: true, displayName: true, avatarKey: true },
    });
    if (!contact) throw new NotFoundException('联系方式不存在');

    const mime = file.mimetype ?? '';
    if (!Object.hasOwn(ALLOWED_IMAGE_MIME, mime)) {
      throw new BadRequestException(
        `不支持的头像格式: ${mime || 'unknown'}（仅支持 JPEG / PNG / WebP / AVIF）`,
      );
    }
    validateUpload(file);
    if (!verifyImageSignature(file.buffer, file.mimetype)) {
      throw new BadRequestException(
        '文件内容与声明格式不符（头像仅支持 jpeg / png / webp / avif，须通过魔数校验）',
      );
    }

    const stored = await this.storage.upload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });

    const staleKey = contact.avatarKey;
    // 极端情况下新旧 key 相同（同一次上传返回同一对象）时不能删，否则刚传的就被删了
    const shouldDeleteStale = Boolean(staleKey) && staleKey !== stored.storageKey;

    await this.prisma.employeeContact.update({
      where: { id },
      data: { avatarKey: stored.storageKey, avatarUrl: stored.url },
    });

    if (shouldDeleteStale) {
      await this.storage.delete(staleKey as string);
    }

    await this.audit.record({
      actor,
      action: 'contacts.update_avatar',
      targetType: 'EmployeeContact',
      targetId: id,
      summary: `${shouldDeleteStale ? '替换' : '上传'}员工「${contact.displayName}」的头像` +
        `（删除旧对象：${shouldDeleteStale ? '是' : '否'}）`,
      diff: {
        before: { avatarKey: staleKey },
        after: { avatarKey: stored.storageKey },
      },
    });

    this.logger.log(`员工头像已${shouldDeleteStale ? '替换' : '上传'}: ${contact.displayName} by ${actor.email}`);
    this.notifyFrontend();
    return this.findById(id);
  }

  /** 移除员工头像：清空字段并删除存储对象（存储中不留孤儿文件） */
  async removeAvatar(id: string, actor: ActorContext): Promise<ContactDto> {
    const contact = await this.prisma.employeeContact.findUnique({
      where: { id },
      select: { id: true, displayName: true, avatarKey: true },
    });
    if (!contact) throw new NotFoundException('联系方式不存在');

    if (!contact.avatarKey) return this.findById(id); // 幂等：本就没有头像

    await this.prisma.employeeContact.update({
      where: { id },
      data: { avatarKey: null, avatarUrl: null },
    });
    await this.storage.delete(contact.avatarKey);

    await this.audit.record({
      actor,
      action: 'contacts.remove_avatar',
      targetType: 'EmployeeContact',
      targetId: id,
      summary: `移除员工「${contact.displayName}」的头像`,
      diff: { before: { avatarKey: contact.avatarKey }, after: { avatarKey: null } },
    });

    this.logger.log(`员工头像已移除: ${contact.displayName} by ${actor.email}`);
    this.notifyFrontend();
    return this.findById(id);
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

    this.notifyFrontend();
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

    this.notifyFrontend();
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
        phone: true,
        avatarKey: true,
        avatarUrl: true,
        sortOrder: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map((r) => ({
      displayName: r.displayName,
      jobTitle: r.jobTitle,
      displayEmail: r.displayEmail,
      whatsapp: r.whatsapp,
      phone: r.phone,
      avatarUrl: this.resolveAvatarUrl(r.avatarKey, r.avatarUrl),
      sortOrder: r.sortOrder,
    }));
  }

  // ── 内部 ────────────────────────────────────────────────────

  /**
   * 头像访问地址：**优先由 avatarKey 经当前 StorageProvider 动态生成**，
   * 取不到才回退到 avatarUrl 快照。
   *
   * 为什么不能只信快照：avatarUrl 是上传那一刻写下的地址快照，
   * 存储后端一换（COS → 本地）、或域名一改，它就指向不存在的地址。
   * avatarKey 是稳定的 storageKey（media/YYYY/MM/<uuid>.<ext>），与介质无关。
   *
   * 2026-10-26 实际踩过：`repair-uploads-media-urls.cjs --prune` 把文件已丢的
   * 头像引用置为 NULL，而 listPublic 只读 avatarUrl，导致联系页 14 位员工
   * 头像全部消失——文件其实好好躺在磁盘上，只是没人去生成地址。
   *
   * key 非法（历史脏数据）时退回快照，不让单条记录打断整个列表。
   */
  private resolveAvatarUrl(avatarKey: string | null, snapshot: string | null): string | null {
    if (avatarKey) {
      try {
        return this.storage.getUrl(avatarKey);
      } catch {
        this.logger.warn(`头像 storageKey 非法，回退快照地址：${avatarKey}`);
      }
    }
    return snapshot;
  }

  private toDto(contact: {
    id: string;
    adminUserId: string;
    displayName: string;
    jobTitle: string | null;
    displayEmail: string | null;
    whatsapp: string | null;
    phone: string | null;
    avatarKey: string | null;
    avatarUrl: string | null;
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
      phone: contact.phone,
      avatarKey: contact.avatarKey,
      avatarUrl: this.resolveAvatarUrl(contact.avatarKey, contact.avatarUrl),
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
