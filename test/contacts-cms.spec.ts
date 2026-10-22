import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ContactsService } from '../src/modules/cms/contacts/contacts.service';
import { ListContactsQueryDto, UpsertContactDto } from '../src/modules/cms/contacts/dto/contact.dto';
import type { PrismaService } from '../src/modules/prisma/prisma.service';
import type { AuditLogService } from '../src/modules/rbac/audit-log.service';
import type { RevalidationService } from '../src/modules/revalidation/revalidation.service';
import type { StorageProvider } from '../src/modules/media/storage/storage.interface';
import { makeRevalidationMock } from './helpers/revalidation-mock';

/**
 * 员工联系方式 CMS 单元测试（Phase 4.6 + Phase 5.4 phone / avatar 字段）。
 *
 * 覆盖：
 *   · DTO 校验：whatsapp / phone 的 E.164 归一化与非法值拒绝
 *   · Service.upsert：字段映射（含 phone）、空值清空、幽灵员工 400
 *   · Service.listPublic：phone / avatarUrl 进入公开契约，
 *     internalNote / avatarKey / 登录邮箱绝不外泄
 *   · Service.setAvatar：上传→落库→删旧对象（无孤儿文件）
 *   · Service.removeAvatar：清字段 + 删对象；无头像时幂等
 *   · Service.setShowOnSite：幂等；remove 只删联系方式不动账号
 *
 * 数据库不参与：PrismaClient 与 StorageProvider 均以 jest mock 替换。
 */

const ACTOR = {
  id: 'actor-1',
  email: 'admin@bailingwooden.com',
  name: 'Administrator',
  permissions: new Set(['contacts.update', 'contacts.read']),
  isSuperAdmin: true,
} as never;

const EMPLOYEE = { id: 'emp-1', name: '王敏', email: 'wangmin@bailingwooden.com', isActive: true };

function makePrismaMock() {
  return {
    adminUser: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    employeeContact: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function makeStorageMock() {
  return {
    provider: 'LOCAL' as const,
    upload: jest.fn().mockImplementation(async (object: { mimeType: string }) => ({
      storageKey: 'media/2026/10/new-avatar.webp',
      filename: 'new-avatar.webp',
      url: 'http://127.0.0.1:4000/uploads/media/2026/10/new-avatar.webp',
      mimeType: object.mimeType,
    })),
    delete: jest.fn().mockResolvedValue(undefined),
    getUrl: jest.fn().mockReturnValue('http://127.0.0.1:4000/uploads/media/2026/10/new-avatar.webp'),
    exists: jest.fn().mockResolvedValue(true),
  };
}

function makeService(prisma: ReturnType<typeof makePrismaMock>, storage = makeStorageMock()) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const revalidation = makeRevalidationMock();
  const service = new ContactsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditLogService,
    revalidation as unknown as RevalidationService,
    storage as unknown as StorageProvider,
  );
  return { service, audit, revalidation, storage };
}

/** 让 $transaction 直接执行回调（回调里的 tx 就是同一个 mock） */
function runTransactionInline(prisma: ReturnType<typeof makePrismaMock>) {
  prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
}

async function validateDto<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto as object);
  return { dto, errors };
}

// ── DTO 校验 ─────────────────────────────────────────────

describe('UpsertContactDto — phone / whatsapp 国际号码', () => {
  const BASE = {
    adminUserId: 'emp-1',
    displayName: 'Mandy Yang',
  };

  it('phone：合法 E.164 原样通过', async () => {
    const { dto, errors } = await validateDto(UpsertContactDto, { ...BASE, phone: '+8613287684805' });
    expect(errors).toHaveLength(0);
    expect(dto.phone).toBe('+8613287684805');
  });

  it('phone：带空格 / 连字符 / 括号时归一化为纯 E.164', async () => {
    const { dto, errors } = await validateDto(UpsertContactDto, { ...BASE, phone: '+86 133-2876-4805' });
    expect(errors).toHaveLength(0);
    expect(dto.phone).toBe('+8613328764805');
  });

  it('phone：空串 → undefined（表示不提供）', async () => {
    const { dto, errors } = await validateDto(UpsertContactDto, { ...BASE, phone: '   ' });
    expect(errors).toHaveLength(0);
    expect(dto.phone).toBeUndefined();
  });

  it('phone：缺国际区号 → 400 级校验错误', async () => {
    const { dto, errors } = await validateDto(UpsertContactDto, { ...BASE, phone: '13328764805' });
    expect(errors.length).toBeGreaterThan(0);
    expect(dto.phone).toBe('13328764805');
  });

  it('phone：位数不足 / 含字母 → 校验错误', async () => {
    for (const bad of ['+8613', '+8618463661950123456', '+86abc1234567']) {
      const { errors } = await validateDto(UpsertContactDto, { ...BASE, phone: bad });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('phone 与 whatsapp 相互独立：可只填其一，也可同时填不同号码', async () => {
    const onlyPhone = await validateDto(UpsertContactDto, { ...BASE, phone: '+8613287684805' });
    expect(onlyPhone.errors).toHaveLength(0);
    expect(onlyPhone.dto.whatsapp).toBeUndefined();

    const both = await validateDto(UpsertContactDto, {
      ...BASE,
      whatsapp: '+8615863669061',
      phone: '+8613287684805',
    });
    expect(both.errors).toHaveLength(0);
    expect(both.dto.whatsapp).toBe('+8615863669061');
    expect(both.dto.phone).toBe('+8613287684805');
  });

  it('whatsapp 仍是必填 E.164，回归不破坏', async () => {
    const { errors } = await validateDto(UpsertContactDto, { ...BASE, whatsapp: '5863669061' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('displayEmail：非法邮箱仍被拒', async () => {
    const { errors } = await validateDto(UpsertContactDto, { ...BASE, displayEmail: 'not-an-email' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('ListContactsQueryDto：showOnSite 字符串布尔可解析', async () => {
    const { dto, errors } = await validateDto(ListContactsQueryDto, { showOnSite: 'true' });
    expect(errors).toHaveLength(0);
    expect(dto.showOnSite).toBe(true);
  });
});

// ── Service.upsert ───────────────────────────────────────

describe('ContactsService.upsert — phone 落库', () => {
  const BASE_DTO = {
    adminUserId: EMPLOYEE.id,
    displayName: 'Helen Li',
    displayEmail: 'bailing8@bailingwoods.com',
    whatsapp: '+8615863669061',
    phone: '+8613287684805',
    showOnSite: true,
    isLeadContact: false,
    sortOrder: 2,
  } as UpsertContactDto;

  /** upsert 末尾会 findById 回读，这里喂一条完整行 */
  function stubReadBack(prisma: ReturnType<typeof makePrismaMock>, overrides: Record<string, unknown> = {}) {
    const row = {
      id: 'contact-1',
      adminUserId: EMPLOYEE.id,
      displayName: 'Helen Li',
      jobTitle: null,
      displayEmail: 'bailing8@bailingwoods.com',
      whatsapp: '+8615863669061',
      phone: '+8613287684805',
      showOnSite: true,
      isLeadContact: false,
      sortOrder: 2,
      internalNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      adminUser: EMPLOYEE,
      ...overrides,
    };
    prisma.employeeContact.findUnique.mockResolvedValue(row);
    return row;
  }

  it('create：phone 与 whatsapp 一并写入', async () => {
    const prisma = makePrismaMock();
    runTransactionInline(prisma);
    prisma.adminUser.findUnique.mockResolvedValue(EMPLOYEE);
    prisma.employeeContact.create.mockResolvedValue({ id: 'contact-1' });
    prisma.employeeContact.findUnique.mockResolvedValueOnce(null); // existing 查询 → 不存在
    stubReadBack(prisma); // 之后所有 findUnique 走默认返回值 = upsert 末尾的回读

    const { service, audit } = makeService(prisma);
    await service.upsert(BASE_DTO, ACTOR);

    expect(prisma.employeeContact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminUserId: EMPLOYEE.id,
          whatsapp: '+8615863669061',
          phone: '+8613287684805',
          showOnSite: true,
          isLeadContact: false,
          sortOrder: 2,
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'contacts.create', targetType: 'EmployeeContact' }),
    );
  });

  it('update：phone 变更被写入，未提供 phone 时清空为 null', async () => {
    const prisma = makePrismaMock();
    runTransactionInline(prisma);
    prisma.adminUser.findUnique.mockResolvedValue(EMPLOYEE);
    prisma.employeeContact.update.mockResolvedValue({ id: 'contact-1' });
    prisma.employeeContact.findUnique.mockResolvedValueOnce({ id: 'contact-1' }); // existing → 已存在
    stubReadBack(prisma, { phone: null });

    const { service } = makeService(prisma);
    const { phone: _dropped, ...withoutPhone } = BASE_DTO;
    await service.upsert(withoutPhone as UpsertContactDto, ACTOR);

    expect(prisma.employeeContact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ whatsapp: '+8615863669061', phone: null }),
      }),
    );
  });

  it('showOnSite / isLeadContact 缺省为 false', async () => {
    const prisma = makePrismaMock();
    runTransactionInline(prisma);
    prisma.adminUser.findUnique.mockResolvedValue(EMPLOYEE);
    prisma.employeeContact.create.mockResolvedValue({ id: 'contact-1' });
    prisma.employeeContact.findUnique.mockResolvedValueOnce(null);
    stubReadBack(prisma, { showOnSite: false, isLeadContact: false, phone: null });

    const { service } = makeService(prisma);
    await service.upsert(
      { adminUserId: EMPLOYEE.id, displayName: 'X Y' } as UpsertContactDto,
      ACTOR,
    );

    expect(prisma.employeeContact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ showOnSite: false, isLeadContact: false, phone: null }),
      }),
    );
  });

  it('幽灵员工：adminUserId 不存在 → 400，绝不建库', async () => {
    const prisma = makePrismaMock();
    prisma.adminUser.findUnique.mockResolvedValue(null);

    const { service } = makeService(prisma);
    await expect(
      service.upsert({ adminUserId: 'ghost', displayName: '幽灵' } as UpsertContactDto, ACTOR),
    ).rejects.toThrow('员工账号不存在');
    expect(prisma.employeeContact.create).not.toHaveBeenCalled();
    expect(prisma.employeeContact.update).not.toHaveBeenCalled();
  });
});

// ── Service.listPublic ───────────────────────────────────

describe('ContactsService.listPublic — phone 进入公开契约', () => {
  it('只返回 showOnSite=true 且账号启用中的记录，且带 phone / avatarUrl', async () => {
    const prisma = makePrismaMock();
    prisma.employeeContact.findMany.mockResolvedValue([
      {
        displayName: 'Helen Li',
        jobTitle: null,
        displayEmail: 'bailing8@bailingwoods.com',
        whatsapp: '+8615863669061',
        phone: '+8613287684805',
        avatarUrl: 'http://127.0.0.1:4000/uploads/media/2026/10/a.webp',
        sortOrder: 2,
      },
    ]);

    const { service } = makeService(prisma);
    const rows = await service.listPublic();

    expect(prisma.employeeContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { showOnSite: true, adminUser: { isActive: true } },
        select: expect.objectContaining({ phone: true, avatarUrl: true }),
      }),
    );
    expect(rows).toEqual([
      {
        displayName: 'Helen Li',
        jobTitle: null,
        displayEmail: 'bailing8@bailingwoods.com',
        whatsapp: '+8615863669061',
        phone: '+8613287684805',
        avatarUrl: 'http://127.0.0.1:4000/uploads/media/2026/10/a.webp',
        sortOrder: 2,
      },
    ]);
  });

  /** 有 12 字节 RIFF/WEBP 头的合法 webp buffer（通过魔数校验） */
  function webpBuffer(): Buffer {
    return Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');
  }

  function multerFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
    return {
      buffer: webpBuffer(),
      originalname: 'avatar.webp',
      mimetype: 'image/webp',
      size: 16,
      ...overrides,
    } as Express.Multer.File;
  }

  it('公开契约绝不包含 internalNote / adminUserId / avatarKey / 登录邮箱', async () => {
    const prisma = makePrismaMock();
    prisma.employeeContact.findMany.mockResolvedValue([
      {
        displayName: 'Mandy Yang',
        jobTitle: null,
        displayEmail: 'bailing1@bailingwoods.com',
        whatsapp: '+8618463661950',
        phone: null,
        avatarUrl: 'http://127.0.0.1:4000/uploads/media/2026/10/a.webp',
        sortOrder: 1,
      },
    ]);

    const { service } = makeService(prisma);
    const [row] = await service.listPublic();

    expect(Object.keys(row).sort()).toEqual(
      ['avatarUrl', 'displayEmail', 'displayName', 'jobTitle', 'phone', 'sortOrder', 'whatsapp'].sort(),
    );
    expect(row).not.toHaveProperty('internalNote');
    expect(row).not.toHaveProperty('adminUserId');
    expect(row).not.toHaveProperty('avatarKey');
  });

  it('空列表不抛错', async () => {
    const prisma = makePrismaMock();
    prisma.employeeContact.findMany.mockResolvedValue([]);
    const { service } = makeService(prisma);
    await expect(service.listPublic()).resolves.toEqual([]);
  });
});

// ── Service.setShowOnSite / remove ───────────────────────

describe('ContactsService — 展示开关与删除', () => {
  it('setShowOnSite：状态相同直接回读（幂等，不重复写）', async () => {
    const prisma = makePrismaMock();
    prisma.employeeContact.findUnique
      .mockResolvedValueOnce({ id: 'c1', displayName: 'A B', showOnSite: true })
      .mockResolvedValueOnce({
        id: 'c1',
        adminUserId: EMPLOYEE.id,
        displayName: 'A B',
        jobTitle: null,
        displayEmail: null,
        whatsapp: null,
        phone: null,
        showOnSite: true,
        isLeadContact: false,
        sortOrder: 0,
        internalNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        adminUser: EMPLOYEE,
      });

    const { service } = makeService(prisma);
    await service.setShowOnSite('c1', true, ACTOR);

    expect(prisma.employeeContact.update).not.toHaveBeenCalled();
  });

  it('setShowOnSite：404 当联系方式不存在', async () => {
    const prisma = makePrismaMock();
    prisma.employeeContact.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);
    await expect(service.setShowOnSite('nope', true, ACTOR)).rejects.toThrow('联系方式不存在');
  });

  it('remove：只删联系方式，不动员工账号', async () => {
    const prisma = makePrismaMock();
    prisma.employeeContact.findUnique.mockResolvedValue({
      id: 'c1',
      displayName: 'A B',
      adminUserId: EMPLOYEE.id,
    });
    prisma.employeeContact.delete.mockResolvedValue({ id: 'c1' });

    const { service, audit } = makeService(prisma);
    const result = await service.remove('c1', ACTOR);

    expect(result).toEqual({ id: 'c1' });
    expect(prisma.employeeContact.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    // 员工账号必须保持不动（mock 中不存在 adminUser.update 即证明从未被调用）
    expect(prisma.adminUser).not.toHaveProperty('update');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'contacts.delete', targetType: 'EmployeeContact' }),
    );
  });
});

// ── 头像（Phase 5.4）─────────────────────────────────────

describe('ContactsService.setAvatar — 上传 / 替换', () => {
  /** 12 字节 RIFF/WEBP 头的合法 webp buffer */
  const webp = (): Buffer => Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');

  function multerFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
    return {
      buffer: webp(),
      originalname: 'avatar.webp',
      mimetype: 'image/webp',
      size: 16,
      ...overrides,
    } as Express.Multer.File;
  }

  /** setAvatar 首查 contact（拿旧 key）→ update → findById 回读 */
  function stubContact(prisma: ReturnType<typeof makePrismaMock>, overrides: Record<string, unknown> = {}) {
    const lookup = {
      id: 'c1',
      displayName: 'Helen Li',
      avatarKey: null as string | null,
      ...overrides,
    };
    const readBack = {
      id: 'c1',
      adminUserId: EMPLOYEE.id,
      displayName: 'Helen Li',
      jobTitle: null,
      displayEmail: 'bailing8@bailingwoods.com',
      whatsapp: '+8615863669061',
      phone: '+8613287684805',
      avatarKey: 'media/2026/10/new-avatar.webp',
      avatarUrl: 'http://127.0.0.1:4000/uploads/media/2026/10/new-avatar.webp',
      showOnSite: true,
      isLeadContact: false,
      sortOrder: 2,
      internalNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      adminUser: EMPLOYEE,
    };
    prisma.employeeContact.findUnique
      .mockResolvedValueOnce(lookup)
      .mockResolvedValueOnce(readBack);
    return { lookup, readBack };
  }

  it('首次上传：写入新 key/url，不触发删除（原本没有头像）', async () => {
    const prisma = makePrismaMock();
    stubContact(prisma, { avatarKey: null });
    const { service, storage, audit } = makeService(prisma);

    await service.setAvatar('c1', multerFile(), ACTOR);

    expect(storage.upload).toHaveBeenCalledWith(
      expect.objectContaining({ originalName: 'avatar.webp', mimeType: 'image/webp' }),
    );
    expect(prisma.employeeContact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: {
        avatarKey: 'media/2026/10/new-avatar.webp',
        avatarUrl: 'http://127.0.0.1:4000/uploads/media/2026/10/new-avatar.webp',
      },
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'contacts.update_avatar' }),
    );
  });

  it('替换头像：旧对象被删除（存储不留孤儿文件）', async () => {
    const prisma = makePrismaMock();
    stubContact(prisma, { avatarKey: 'media/2026/09/old-avatar.webp' });
    const { service, storage, audit } = makeService(prisma);

    await service.setAvatar('c1', multerFile(), ACTOR);

    // 先落库新对象，再删旧对象
    expect(prisma.employeeContact.update).toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledWith('media/2026/09/old-avatar.webp');
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contacts.update_avatar',
        summary: expect.stringContaining('替换'),
      }),
    );
  });

  it('上传后再通知前台失效（公开契约变化）', async () => {
    const prisma = makePrismaMock();
    stubContact(prisma, { avatarKey: 'media/2026/09/old-avatar.webp' });
    const { service, revalidation } = makeService(prisma);

    await service.setAvatar('c1', multerFile(), ACTOR);
    expect(revalidation.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ['/contact'] }),
    );
  });

  it('魔数校验失败：非 webp 内容冒充 image/webp → 400，且不落库不调存储', async () => {
    const prisma = makePrismaMock();
    stubContact(prisma, { avatarKey: null });
    const { service, storage } = makeService(prisma);

    await expect(
      service.setAvatar('c1', multerFile({ buffer: Buffer.from('#!/bin/sh rm -rf /') }), ACTOR),
    ).rejects.toThrow('文件内容与声明格式不符');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.employeeContact.update).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('MIME 白名单外格式 → 400（PDF 虽在媒体库白名单，但不可作头像）', async () => {
    const prisma = makePrismaMock();
    stubContact(prisma, { avatarKey: null });
    const { service, storage } = makeService(prisma);

    await expect(
      service.setAvatar(
        'c1',
        multerFile({ mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4xxxxxxx') }),
        ACTOR,
      ),
    ).rejects.toThrow('不支持的头像格式');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('联系方式不存在 → 404，绝不碰存储', async () => {
    const prisma = makePrismaMock();
    prisma.employeeContact.findUnique.mockResolvedValue(null);
    const { service, storage } = makeService(prisma);

    await expect(service.setAvatar('nope', multerFile(), ACTOR)).rejects.toThrow('联系方式不存在');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe('ContactsService.removeAvatar', () => {
  function stubContact(prisma: ReturnType<typeof makePrismaMock>, avatarKey: string | null) {
    const readBack = {
      id: 'c1',
      adminUserId: EMPLOYEE.id,
      displayName: 'Helen Li',
      jobTitle: null,
      displayEmail: null,
      whatsapp: null,
      phone: null,
      avatarKey: null,
      avatarUrl: null,
      showOnSite: true,
      isLeadContact: false,
      sortOrder: 2,
      internalNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      adminUser: EMPLOYEE,
    };
    prisma.employeeContact.findUnique
      .mockResolvedValueOnce({ id: 'c1', displayName: 'Helen Li', avatarKey })
      .mockResolvedValueOnce(readBack);
  }

  it('有头像：清空字段并删除存储对象', async () => {
    const prisma = makePrismaMock();
    stubContact(prisma, 'media/2026/10/old.webp');
    const { service, storage, audit } = makeService(prisma);

    await service.removeAvatar('c1', ACTOR);

    expect(prisma.employeeContact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { avatarKey: null, avatarUrl: null },
    });
    expect(storage.delete).toHaveBeenCalledWith('media/2026/10/old.webp');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'contacts.remove_avatar' }),
    );
  });

  it('无头像：幂等返回，不删对象不写库', async () => {
    const prisma = makePrismaMock();
    stubContact(prisma, null);
    const { service, storage } = makeService(prisma);

    await service.removeAvatar('c1', ACTOR);

    expect(prisma.employeeContact.update).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('联系方式不存在 → 404', async () => {
    const prisma = makePrismaMock();
    prisma.employeeContact.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);
    await expect(service.removeAvatar('nope', ACTOR)).rejects.toThrow('联系方式不存在');
  });
});
