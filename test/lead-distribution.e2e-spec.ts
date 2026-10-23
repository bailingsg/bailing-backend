import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole, LeadAssignmentSource } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { setupApp } from '../src/app.setup';
import { LeadDistributionService } from '../src/modules/cms/lead-distribution/lead-distribution.service';

/**
 * 询盘分配引擎端到端测试（Phase 4.6）。
 *
 * 全程打真实 PostgreSQL，验证规格里点名要求的场景：
 *   1. 正常轮询按队列顺序分配，指针持久化在 lead_round_robin_state
 *   2. 并发提交不把多条询盘分给同一个人（行锁串行化）
 *   3. 重复请求幂等（同一询盘二次触发不重复接单）
 *   4. 事务回滚：写分配失败时指针/进度/归属全部不回滚残留
 *   5. 倾斜计划组内轮流，每人独立累计；全部达标自动完成并恢复正常轮询
 *   6. 手动关闭立即恢复正常轮询，且**保留**正常轮询指针
 *   7. 冷却结束自动恢复执行
 *   8. 员工停用立即退出队列，计划详情显示「账号已停用」
 *   9. RFQ 公开创建入口自动分配，后台列表（JWT + rfq.read）带出承接人
 *  10. RBAC：无令牌 401，缺权限 403
 */

const ADMIN_EMAIL = 'e2e-ld-admin@bailingwooden.test';
const ADMIN_PASSWORD = 'E2E-ld-admin-2026!';
const LIMITED_EMAIL = 'e2e-ld-limited@bailingwooden.test';
const LIMITED_PASSWORD = 'E2E-ld-limited-2026!';
const EMPLOYEE_PREFIX = 'e2e-ld-emp';

interface LeadEmployee {
  id: string;
  email: string;
}

interface CreatedRfq {
  id: string;
  assigneeEmail: string;
  source: LeadAssignmentSource;
  roundRobinIndex: number | null;
  planId: string | null;
}

describe('询盘分配引擎（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: LeadDistributionService;
  let token: string;
  let limitedToken: string;
  let employees: LeadEmployee[];
  let createdRfqIds: string[] = [];
  /** 被临时停用的非 e2e 历史员工（afterAll 原样恢复，不删数据） */
  let displacedLeadIds: string[] = [];

  const auth = (): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

  /** 通过公开入口提交一条询盘，并读回它的分配结果 */
  async function submitRfq(tag: string): Promise<CreatedRfq> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/rfq')
      .send({
        name: `LD Buyer ${tag}`,
        company: 'LD Buyer Ltd',
        email: `ld-${tag}@buyer.test`,
        country: 'United States',
        message: `Please quote panels (${tag}).`,
      })
      .expect(201);
    const rfqId = res.body.data.id as string;
    createdRfqIds.push(rfqId);

    const assignment = await prisma.leadAssignment.findFirstOrThrow({
      where: { rfqId },
      include: { assignee: { select: { email: true } } },
    });
    return {
      id: rfqId,
      assigneeEmail: assignment.assignee.email,
      source: assignment.source,
      roundRobinIndex: assignment.roundRobinIndex,
      planId: assignment.planId,
    };
  }

  /** 当前生效的正常轮询下一位承接人邮箱 */
  async function nextRoundRobinEmail(): Promise<string | null> {
    const state = await service.getState();
    return state.nextAssignee?.email ?? null;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    service = app.get(LeadDistributionService);

    await cleanup();

    // 轮询队列是全局的（所有 isActive 且 isLeadContact 的员工）。开发库可能残留
    // 历史员工（早期生产数据迁移带入，如 wangmin@bailingwooden.com），会使队列
    // 长度/顺序/指针断言漂移。快照并**临时停用**非 e2e 员工，afterAll 原样恢复——
    // 不删除任何数据（历史员工是否清理待业务决定）。
    const foreignLeads = await prisma.adminUser.findMany({
      where: {
        isActive: true,
        email: { not: { startsWith: 'e2e-ld-' } },
        contact: { isLeadContact: true },
      },
      select: { id: true },
    });
    displacedLeadIds = foreignLeads.map((u) => u.id);
    if (displacedLeadIds.length > 0) {
      await prisma.adminUser.updateMany({
        where: { id: { in: displacedLeadIds } },
        data: { isActive: false },
      });
    }

    // 主账号：显式绑定 SUPER_ADMIN（走真实 RBAC，而非旧枚举回退）
    await prisma.adminUser.deleteMany({ where: { email: ADMIN_EMAIL } });
    const superRole = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
    await prisma.adminUser.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 4),
        name: 'LD E2E Admin',
        role: AdminRole.ADMIN,
        isActive: true,
        userRoles: { create: { roleId: superRole.id } },
      },
    });

    // 受限账号：只有一个与询盘分配无关的角色（用于 403 验证）
    await prisma.adminUser.deleteMany({ where: { email: LIMITED_EMAIL } });
    const limitedRole = await prisma.role.create({
      data: {
        key: `E2E_LD_LIMITED_${Date.now().toString(36)}`,
        name: 'E2E 受限角色（无分配权限）',
        description: '仅用于验证询盘分配接口的权限拦截',
        rolePermissions: {
          create: [
            {
              permission: {
                connect: { key: 'dashboard.read' },
              },
            },
          ],
        },
      },
    });
    const limited = await prisma.adminUser.create({
      data: {
        email: LIMITED_EMAIL,
        passwordHash: bcrypt.hashSync(LIMITED_PASSWORD, 4),
        name: 'LD E2E Limited',
        role: AdminRole.EDITOR,
        isActive: true,
        userRoles: { create: { roleId: limitedRole.id } },
      },
    });

    // 三名可分配员工（队列顺序 A → B → C）
    employees = [];
    const specs: Array<{ suffix: string; name: string; sortOrder: number }> = [
      { suffix: 'a', name: 'LD Employee A', sortOrder: 0 },
      { suffix: 'b', name: 'LD Employee B', sortOrder: 1 },
      { suffix: 'c', name: 'LD Employee C', sortOrder: 2 },
    ];
    for (const spec of specs) {
      await prisma.adminUser.deleteMany({ where: { email: `${EMPLOYEE_PREFIX}-${spec.suffix}@test.local` } });
      const employee = await prisma.adminUser.create({
        data: {
          email: `${EMPLOYEE_PREFIX}-${spec.suffix}@test.local`,
          passwordHash: bcrypt.hashSync('Employee-pass-2026', 4),
          name: spec.name,
          jobTitle: 'Sales',
          role: AdminRole.EDITOR,
          isActive: true,
          contact: {
            create: {
              displayName: spec.name,
              jobTitle: 'Sales',
              isLeadContact: true,
              showOnSite: false,
              sortOrder: spec.sortOrder,
            },
          },
        },
      });
      employees.push({ id: employee.id, email: employee.email });
    }

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    token = login.body.data.accessToken as string;

    const limitedLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: LIMITED_EMAIL, password: LIMITED_PASSWORD })
      .expect(200);
    limitedToken = limitedLogin.body.data.accessToken as string;

    // 清理受限账号在用例中的引用，避免 eslint 未使用告警
    void limited.id;
  });

  afterAll(async () => {
    await cleanup();
    // 恢复被临时停用的历史员工（原样带回，不删除）
    if (displacedLeadIds.length > 0) {
      await prisma.adminUser.updateMany({
        where: { id: { in: displacedLeadIds } },
        data: { isActive: true },
      });
    }
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const testEmails = [
      ADMIN_EMAIL,
      LIMITED_EMAIL,
      `${EMPLOYEE_PREFIX}-a@test.local`,
      `${EMPLOYEE_PREFIX}-b@test.local`,
      `${EMPLOYEE_PREFIX}-c@test.local`,
    ];
    const users = await prisma.adminUser.findMany({
      where: { email: { in: testEmails } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);

    // 先删分配记录（外键 Restrict 指向 admin_users），再删账号
    await prisma.leadAssignment.deleteMany({
      where: { OR: [{ assigneeId: { in: userIds } }, { rfq: { email: { contains: '@buyer.test' } } }] },
    });
    await prisma.leadDistributionItem.deleteMany({
      where: { adminUserId: { in: userIds } },
    });
    await prisma.leadDistributionPlan.deleteMany({
      where: { OR: [{ createdBy: { in: userIds } }, { name: { startsWith: 'E2E' } }] },
    });
    await prisma.employeeContact.deleteMany({ where: { adminUserId: { in: userIds } } });
    await prisma.rfq.deleteMany({ where: { email: { contains: '@buyer.test' } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: { in: userIds } } });
    await prisma.role.deleteMany({ where: { key: { startsWith: 'E2E_LD_LIMITED' } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.leadRoundRobinState.deleteMany({});
    createdRfqIds = [];
  }

  const employeeEmails = () => employees.map((e) => e.email);

  /** 环形 successor：给定当前承接人，返回队列里的下一位 */
  function successorEmail(current: string | null): string | null {
    const queue = employeeEmails();
    if (queue.length === 0) return null;
    if (!current) return queue[0];
    const idx = queue.indexOf(current);
    return queue[(idx + 1) % queue.length] ?? null;
  }

  /* ---------------------------- 正常轮询 ---------------------------- */

  it('初始状态：队列按 sortOrder 排列，下一位承接人为队首，模式为正常轮询', async () => {
    const state = await service.getState();

    expect(state.currentMode).toBe(LeadAssignmentSource.ROUND_ROBIN);
    expect(state.queueLength).toBe(3);
    expect(state.queue.map((m) => m.email)).toEqual(employeeEmails());
    expect(state.queue.map((m) => m.index)).toEqual([0, 1, 2]);
    expect(state.nextAssignee?.email).toBe(employees[0].email);
    expect(state.nextAssignee?.index).toBe(0);
    expect(state.activePlan).toBeNull();
  });

  it('按队列顺序轮流分配，第 4 条回到队首；指针持久化在数据库', async () => {
    const tags = ['rr1', 'rr2', 'rr3', 'rr4'];
    const results = [];
    for (const tag of tags) results.push(await submitRfq(tag));

    expect(results.map((r) => r.assigneeEmail)).toEqual([
      employees[0].email,
      employees[1].email,
      employees[2].email,
      employees[0].email,
    ]);
    expect(results.map((r) => r.roundRobinIndex)).toEqual([0, 1, 2, 0]);
    expect(results.every((r) => r.source === LeadAssignmentSource.ROUND_ROBIN)).toBe(true);

    // 指针落库（服务重启 / 换实例都从这里恢复，不依赖内存）
    const stateRow = await prisma.leadRoundRobinState.findFirstOrThrow();
    expect(stateRow.lastAssigneeId).toBe(employees[0].id);
    expect(stateRow.lastIndex).toBe(0);
    expect(stateRow.cycleCount).toBe(4);

    expect(await nextRoundRobinEmail()).toBe(employees[1].email);
  });

  it('并发提交 6 条询盘：每人恰好 2 条（行锁串行化，不重复不遗漏）', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => submitRfq(`cc${i}`)),
    );

    const counts = new Map<string, number>();
    for (const r of results) {
      counts.set(r.assigneeEmail, (counts.get(r.assigneeEmail) ?? 0) + 1);
    }
    // 6 条分给 3 人，必须严格均分；没有行锁时会全部落在同一人头上
    expect([...counts.values()].sort()).toEqual([2, 2, 2]);
    expect(counts.size).toBe(3);
  });

  it('重复请求：同一询盘二次触发分配保持原承接人，不新增分配记录', async () => {
    const first = await submitRfq('dup1');
    const before = await prisma.leadAssignment.count();

    const again = await service.assignToRfq(first.id);

    expect(again?.assigneeEmail).toBe(first.assigneeEmail);
    expect(await prisma.leadAssignment.count()).toBe(before);

    const rfq = await prisma.rfq.findUniqueOrThrow({
      where: { id: first.id },
      select: { assigneeId: true },
    });
    expect(rfq.assigneeId).not.toBeNull();
  });

  it('事务回滚：提交前失败时，已写的分配记录 / 指针 / 询盘归属全部撤销', async () => {
    // 直接建一条「未分配」询盘，绕过 RFQ 创建入口的自动分配
    const rfq = await prisma.rfq.create({
      data: {
        name: 'LD Rollback Buyer',
        company: 'LD Rollback Ltd',
        email: 'ld-rollback@buyer.test',
        country: 'United States',
        message: 'rollback probe',
      },
    });
    createdRfqIds.push(rfq.id);

    const pointerBefore = await prisma.leadRoundRobinState.findFirst();
    const assignCountBefore = await prisma.leadAssignment.count();

    // 在事务内所有写完成之后、提交之前抛错 → 整个事务必须回滚
    const original = prisma.$transaction.bind(prisma);
    const spy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>) =>
        original(async (tx: unknown) => {
          await fn(tx);
          throw new Error('commit-failed');
        })) as never);

    try {
      await expect(service.assignToRfq(rfq.id)).rejects.toThrow('commit-failed');
    } finally {
      spy.mockRestore();
    }

    const pointerAfter = await prisma.leadRoundRobinState.findFirst();
    expect(pointerAfter?.lastAssigneeId ?? null).toBe(pointerBefore?.lastAssigneeId ?? null);
    expect(pointerAfter?.cycleCount ?? 0).toBe(pointerBefore?.cycleCount ?? 0);
    expect(await prisma.leadAssignment.count()).toBe(assignCountBefore);

    const reloaded = await prisma.rfq.findUniqueOrThrow({
      where: { id: rfq.id },
      select: { assigneeId: true },
    });
    expect(reloaded.assigneeId).toBeNull();

    // 回滚后仍可正常分配，且指针只前进一位（证明没有半提交状态）
    const nextBeforeRecovery = await nextRoundRobinEmail();
    const recovered = await service.assignToRfq(rfq.id);
    expect(recovered?.assigneeEmail).toBe(nextBeforeRecovery);
    expect(await nextRoundRobinEmail()).toBe(successorEmail(nextBeforeRecovery));
    expect(await prisma.leadAssignment.count({ where: { rfqId: rfq.id } })).toBe(1);
  });

  /* ---------------------------- 倾斜计划 ---------------------------- */

  it('倾斜期间组内轮流接单，每人独立累计；全部达标自动完成并恢复正常轮询', async () => {
    // 记录计划开始前的正常轮询指针，用于验证「计划不动指针」
    const pointerBeforePlan = await nextRoundRobinEmail();

    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/lead-distribution/plans')
      .set(auth())
      .send({
        name: 'E2E 倾斜计划-轮流',
        items: [
          { adminUserId: employees[0].id, targetCount: 2 },
          { adminUserId: employees[1].id, targetCount: 2 },
        ],
        cooldownSeconds: 0,
      })
      .expect(201);

    const planId = created.body.data.plan.id as string;
    expect(created.body.data.skipped).toEqual([]);
    expect(created.body.data.plan.status).toBe('ACTIVE');

    const state = await service.getState();
    expect(state.currentMode).toBe(LeadAssignmentSource.PRIORITY_PLAN);
    expect(state.activePlan?.id).toBe(planId);
    expect(state.activePlan?.items.map((i) => i.targetCount)).toEqual([2, 2]);
    expect(state.activePlan?.items.map((i) => i.assignedCount)).toEqual([0, 0]);
    expect(state.activePlan?.completionPercent).toBe(0);
    expect(state.activePlan?.hasTiltCapacity).toBe(true);

    const results = [];
    for (const tag of ['tp1', 'tp2', 'tp3', 'tp4']) results.push(await submitRfq(tag));

    // 组内轮流：A → B → A → B
    expect(results.map((r) => r.assigneeEmail)).toEqual([
      employees[0].email,
      employees[1].email,
      employees[0].email,
      employees[1].email,
    ]);
    expect(results.every((r) => r.source === LeadAssignmentSource.PRIORITY_PLAN)).toBe(true);
    expect(results.every((r) => r.planId === planId)).toBe(true);

    // 计划自动完成，进度是真实计数
    const plan = await service.getPlan(planId);
    expect(plan.status).toBe('COMPLETED');
    expect(plan.completionPercent).toBe(100);
    expect(plan.items.find((i) => i.adminUserId === employees[0].id)?.assignedCount).toBe(2);
    expect(plan.items.find((i) => i.adminUserId === employees[1].id)?.assignedCount).toBe(2);
    expect(plan.items.every((i) => i.remainingCount === 0)).toBe(true);

    // 恢复正常轮询，且指针没有被倾斜计划挪动
    const stateAfter = await service.getState();
    expect(stateAfter.currentMode).toBe(LeadAssignmentSource.ROUND_ROBIN);
    expect(stateAfter.activePlan).toBeNull();
    expect(await nextRoundRobinEmail()).toBe(pointerBeforePlan);
  });

  it('手动关闭：立即恢复正常轮询并保留指针；操作历史可查', async () => {
    const pointerBeforePlan = await nextRoundRobinEmail();

    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/lead-distribution/plans')
      .set(auth())
      .send({
        name: 'E2E 倾斜计划-手动关闭',
        items: [{ adminUserId: employees[2].id, targetCount: 5 }],
        cooldownSeconds: 0,
      })
      .expect(201);
    const planId = created.body.data.plan.id as string;

    const tilted = await submitRfq('mc1');
    expect(tilted.assigneeEmail).toBe(employees[2].email);

    const closed = await request(app.getHttpServer())
      .post(`/api/v1/cms/lead-distribution/plans/${planId}/close`)
      .set(auth())
      .send({ reason: 'E2E 手动关闭验证' })
      .expect(200);

    expect(closed.body.data.status).toBe('CLOSED');
    expect(closed.body.data.isInEffect).toBe(false);
    expect(closed.body.data.closedByEmail).toBe(ADMIN_EMAIL);
    expect(closed.body.data.closedAt).toBeTruthy();
    expect(closed.body.data.resumeAt).toBeNull(); // cooldownSeconds = 0 → 只能手动恢复

    // 关闭即恢复正常轮询，且指针原样保留
    const state = await service.getState();
    expect(state.currentMode).toBe(LeadAssignmentSource.ROUND_ROBIN);
    expect(await nextRoundRobinEmail()).toBe(pointerBeforePlan);

    const next = await submitRfq('mc2');
    expect(next.assigneeEmail).toBe(pointerBeforePlan);
    expect(next.source).toBe(LeadAssignmentSource.ROUND_ROBIN);

    // 操作历史（审计日志）
    const logs = await request(app.getHttpServer())
      .get(`/api/v1/cms/lead-distribution/plans/${planId}/logs`)
      .set(auth())
      .expect(200);
    const actions = (logs.body.data as Array<{ action: string }>).map((l) => l.action);
    expect(actions).toContain('lead_plan.create');
    expect(actions).toContain('lead_plan.close');

    // 冷却为 0 的计划不能自动恢复，也不能重复关闭
    await request(app.getHttpServer())
      .post(`/api/v1/cms/lead-distribution/plans/${planId}/close`)
      .set(auth())
      .send({})
      .expect(400);
  });

  it('冷却结束自动恢复执行', async () => {
    const pointerBeforePlan = await nextRoundRobinEmail();

    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/lead-distribution/plans')
      .set(auth())
      .send({
        name: 'E2E 倾斜计划-冷却',
        items: [{ adminUserId: employees[0].id, targetCount: 3 }],
        cooldownSeconds: 1,
      })
      .expect(201);
    const planId = created.body.data.plan.id as string;

    const closed = await request(app.getHttpServer())
      .post(`/api/v1/cms/lead-distribution/plans/${planId}/close`)
      .set(auth())
      .send({ reason: 'cooldown probe' })
      .expect(200);
    expect(closed.body.data.resumeAt).toBeTruthy();

    // 关闭后立即仍是正常轮询
    expect((await service.getState()).currentMode).toBe(LeadAssignmentSource.ROUND_ROBIN);

    await new Promise((resolve) => setTimeout(resolve, 1300));

    const resumed = await service.getState();
    expect(resumed.activePlan?.status).toBe('ACTIVE');
    expect(resumed.activePlan?.isInEffect).toBe(true);
    expect(resumed.currentMode).toBe(LeadAssignmentSource.PRIORITY_PLAN);

    const tilted = await submitRfq('cd1');
    expect(tilted.assigneeEmail).toBe(employees[0].email);
    expect(tilted.source).toBe(LeadAssignmentSource.PRIORITY_PLAN);

    // 收尾：把计划用完，避免影响后续用例
    await submitRfq('cd2');
    await submitRfq('cd3');
    expect((await service.getState()).currentMode).toBe(LeadAssignmentSource.ROUND_ROBIN);
    expect(await nextRoundRobinEmail()).toBe(pointerBeforePlan);
  });

  it('计划内员工被停用：详情标记「账号已停用」，分配自动跳过且不完成计划', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/cms/lead-distribution/plans')
      .set(auth())
      .send({
        name: 'E2E 倾斜计划-停用员工',
        items: [
          { adminUserId: employees[0].id, targetCount: 2 },
          { adminUserId: employees[1].id, targetCount: 2 },
        ],
      })
      .expect(201);
    const planId = created.body.data.plan.id as string;

    await prisma.adminUser.update({
      where: { id: employees[1].id },
      data: { isActive: false },
    });

    const detail = await service.getPlan(planId);
    const stopped = detail.items.find((i) => i.adminUserId === employees[1].id);
    expect(stopped?.isEmployeeActive).toBe(false);
    expect(stopped?.isEligible).toBe(false);
    expect(detail.items.find((i) => i.adminUserId === employees[0].id)?.isEligible).toBe(true);
    // 账号已停用时不再具备倾斜容量之外的接单能力，但计划本身仍是 ACTIVE（等员工恢复）
    expect(detail.status).toBe('ACTIVE');
    expect(detail.hasTiltCapacity).toBe(true); // A 仍未达标

    const first = await submitRfq('dp1');
    const second = await submitRfq('dp2');
    expect([first.assigneeEmail, second.assigneeEmail]).toEqual([
      employees[0].email,
      employees[0].email,
    ]);
    expect(second.source).toBe(LeadAssignmentSource.PRIORITY_PLAN);

    // A 达标、B 停用 → 计划不自动完成（等 B 恢复），分配回落正常轮询
    const after = await service.getPlan(planId);
    expect(after.status).toBe('ACTIVE');
    expect(after.items.find((i) => i.adminUserId === employees[1].id)?.assignedCount).toBe(0);
    expect(after.hasTiltCapacity).toBe(false);

    const state = await service.getState();
    expect(state.currentMode).toBe(LeadAssignmentSource.ROUND_ROBIN);
    expect(state.activePlan?.id).toBe(planId);

    // 恢复员工后重新具备容量，计划继续执行
    await prisma.adminUser.update({
      where: { id: employees[1].id },
      data: { isActive: true },
    });
    const revived = await service.getPlan(planId);
    expect(revived.items.find((i) => i.adminUserId === employees[1].id)?.isEligible).toBe(true);
    expect(revived.hasTiltCapacity).toBe(true);

    // 清理：把 B 的 2 单目标用完后计划才会完成，这里直接关闭
    await request(app.getHttpServer())
      .post(`/api/v1/cms/lead-distribution/plans/${planId}/close`)
      .set(auth())
      .send({ reason: 'E2E cleanup' })
      .expect(200);
  });

  it('队列为空（全部停用）时询盘保持未分配，不报错', async () => {
    await prisma.adminUser.updateMany({
      where: { id: { in: employees.map((e) => e.id) } },
      data: { isActive: false },
    });

    const created = await request(app.getHttpServer())
      .post('/api/v1/rfq')
      .send({
        name: 'LD NoQueue Buyer',
        company: 'LD NoQueue Ltd',
        email: 'ld-noqueue@buyer.test',
        country: 'United States',
        message: 'no queue probe',
      })
      .expect(201);
    createdRfqIds.push(created.body.data.id as string);

    const reloaded = await prisma.rfq.findUniqueOrThrow({
      where: { id: created.body.data.id as string },
      select: { assigneeId: true },
    });
    expect(reloaded.assigneeId).toBeNull();
    expect(await prisma.leadAssignment.count({ where: { rfqId: created.body.data.id } })).toBe(0);

    const state = await service.getState();
    expect(state.queueLength).toBe(0);
    expect(state.nextAssignee).toBeNull();

    await prisma.adminUser.updateMany({
      where: { id: { in: employees.map((e) => e.id) } },
      data: { isActive: true },
    });
    expect((await service.getState()).queueLength).toBe(3);
  });

  /* ------------------- 接口兼容与权限 ------------------- */

  it('公开创建询盘自动分配；后台列表（JWT + rfq.read）带出承接人字段', async () => {
    const created = await submitRfq('compat1');
    expect(created.assigneeEmail).toBeTruthy();

    const res = await request(app.getHttpServer())
      .get('/api/v1/rfq')
      .set(auth())
      .expect(200);

    const item = (res.body.data.items as Array<Record<string, unknown>>).find(
      (row) => row.id === created.id,
    );
    expect(item).toBeTruthy();
    expect(item?.assigneeEmail).toBe(created.assigneeEmail);
    expect(item?.assigneeId).toBeTruthy();
    expect(item?.assignedAt).toBeTruthy();
  });

  it('无令牌 401；无权限 403；有权限 200', async () => {
    await request(app.getHttpServer()).get('/api/v1/cms/lead-distribution').expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/cms/lead-distribution')
      .set({ Authorization: `Bearer ${limitedToken}` })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/cms/lead-distribution')
      .set(auth())
      .expect(200);

    // 受限账号连创建计划都被拦下
    await request(app.getHttpServer())
      .post('/api/v1/cms/lead-distribution/plans')
      .set({ Authorization: `Bearer ${limitedToken}` })
      .send({
        name: 'E2E 越权计划',
        items: [{ adminUserId: employees[0].id, targetCount: 1 }],
      })
      .expect(403);
  });

  it('创建计划：同一时间只允许一个生效计划；重复员工与幽灵员工 400', async () => {
    const create = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/api/v1/cms/lead-distribution/plans')
        .set(auth())
        .send(body);

    const first = await create({
      name: 'E2E 倾斜计划-占用',
      items: [{ adminUserId: employees[0].id, targetCount: 1 }],
    }).expect(201);

    // 已有生效计划 → 400
    await create({
      name: 'E2E 倾斜计划-第二个',
      items: [{ adminUserId: employees[1].id, targetCount: 1 }],
    }).expect(400);

    await create({
      name: 'E2E 重复员工',
      items: [
        { adminUserId: employees[0].id, targetCount: 1 },
        { adminUserId: employees[0].id, targetCount: 2 },
      ],
    }).expect(400);

    await create({
      name: 'E2E 幽灵员工',
      items: [{ adminUserId: 'ghost-employee-id', targetCount: 1 }],
    }).expect(400);

    // 收尾：关闭占用计划的账号
    await request(app.getHttpServer())
      .post(`/api/v1/cms/lead-distribution/plans/${first.body.data.plan.id}/close`)
      .set(auth())
      .send({ reason: 'E2E cleanup' })
      .expect(200);
  });

  it('可分配员工预检：队列位置、历史承接量与在计划状态都是真实数据', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/cms/lead-distribution/plans/eligible')
      .set(auth())
      .expect(200);

    const rows = res.body.data as Array<{
      adminUserId: string;
      isActive: boolean;
      isLeadContact: boolean;
      assignedTotal: number;
      inActivePlan: boolean;
      queueIndex: number;
    }>;
    expect(Array.isArray(rows)).toBe(true);

    const a = rows.find((r) => r.adminUserId === employees[0].id);
    expect(a?.isActive).toBe(true);
    expect(a?.isLeadContact).toBe(true);
    expect(a?.queueIndex).toBe(0);
    expect(a?.inActivePlan).toBe(false);
    expect(typeof a?.assignedTotal).toBe('number');
  });
});
