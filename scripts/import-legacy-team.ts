/**
 * 旧站员工信息迁移（Phase 5.4）—— 全部走 CMS 接口，不直连数据库。
 *
 * 数据源：docs/migration/legacy-raw/legacy-team-contacts.json（由
 * scripts/parse-legacy-team.ts 从旧站 https://bailingwooden.com/contact-us/ 解析）
 *
 * 执行步骤（每位员工）：
 *   1. POST /api/v1/cms/accounts         创建账号（角色 SALES，口令由后端强随机生成）
 *   2. PUT  /api/v1/cms/contacts         按 adminUserId upsert 对外联系方式
 *
 * 字段映射（旧站卡片 → 新模型）：
 *   name                → AdminUser.name / EmployeeContact.displayName
 *   email               → AdminUser.email（登录邮箱）与 displayEmail（对外展示邮箱，同值）
 *   whatsapp(第 1 个)   → EmployeeContact.whatsapp    （旧站 WhatsApp 绿标图标）
 *   altPhone(第 2 个)   → EmployeeContact.phone       （旧站手机图标）
 *   index               → EmployeeContact.sortOrder  （沿用旧站排序）
 *   showOnSite          → true                       （迁入即公开展示）
 *   isLeadContact       → false                      （询盘分配由业务方显式勾选，脚本不代决策）
 *   jobTitle            → 不设置（旧站未发布职位，**不编造**）
 *
 * 用法：
 *   ts-node scripts/import-legacy-team.ts            # dry-run，只打印将提交的载荷
 *   ts-node scripts/import-legacy-team.ts --apply    # 实际写入
 *
 * 幂等：账号已存在（邮箱唯一，409）时复用该账号；联系方式按 adminUserId upsert。
 * 可安全重复执行。
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = process.env.IMPORT_API_BASE ?? 'http://127.0.0.1:4000/api/v1';
const SRC = 'docs/migration/legacy-raw/legacy-team-contacts.json';
const OUT_CREDENTIALS = '.team-import-credentials.local.json';
const OUT_REPORT = 'docs/migration/legacy-raw/team-import-report.json';

const APPLY = process.argv.includes('--apply');

interface LegacyMember {
  index: number;
  name: string;
  email: string;
  whatsapp: string | null;
  altPhone: string | null;
}

interface CreatedAccount {
  id: string;
  name: string;
  email: string;
}

/** POST /cms/accounts 返回：账号详情 + 一次性明文口令 */
interface CreateAccountResult {
  account: CreatedAccount;
  initialPassword: string;
}

interface ImportRow {
  index: number;
  displayName: string;
  loginEmail: string;
  displayEmail: string | null;
  whatsapp: string | null;
  phone: string | null;
  sortOrder: number;
  account: 'created' | 'reused' | 'skipped' | 'failed';
  accountId: string | null;
  contact: 'created' | 'updated' | 'skipped' | 'failed';
  contactId: string | null;
  initialPassword: string | null;
  error?: string;
}

/** 后端统一响应包裹：{ success: true, data: T } */
interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: number; message: string };
}

async function call<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Envelope<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
  };
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  let body: Envelope<T>;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}，非 JSON 响应：${text.slice(0, 200)}`);
  }
  if (!res.ok || body.success === false) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(`${init.method ?? 'GET'} ${path} → ${msg}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return body;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/[\s\-()[\]]/g, '');
  return /^\+\d{8,15}$/.test(stripped) ? stripped : null;
}

async function main(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('缺少 ADMIN_EMAIL / ADMIN_PASSWORD（读取 .env 失败）');
  }

  const members: LegacyMember[] = JSON.parse(readFileSync(resolve(SRC), 'utf8'));
  console.log(`\n数据源 ${SRC}：${members.length} 位员工`);
  console.log(`模式：${APPLY ? ' APPLY（实际写入）' : 'DRY-RUN（不写入，仅打印载荷）'}\n`);

  // ── 登录 ────────────────────────────────────────────────
  const login = await call<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const token = login.data?.accessToken;
  if (!token) throw new Error('登录响应缺少 accessToken');
  console.log(`已登录：${adminEmail}\n`);

  // ── 取 SALES 角色 id（不硬编码，按 key 查找） ─────────────
  const rolesRes = await call<{ id: string; key: string; name: string; assignable: boolean }[]>(
    '/cms/accounts/assignable-roles',
    { token },
  );
  const salesRole = (rolesRes.data ?? []).find((r) => r.key === 'SALES');
  if (!salesRole) throw new Error('未找到 SALES 角色（角色可能未 seed）');
  console.log(`目标角色：${salesRole.name}（${salesRole.key}）\n`);

  const rows: ImportRow[] = [];

  for (const m of members) {
    const loginEmail = m.email.trim().toLowerCase();
    const whatsapp = normalizePhone(m.whatsapp);
    const phone = normalizePhone(m.altPhone);
    const row: ImportRow = {
      index: m.index,
      displayName: m.name.trim(),
      loginEmail,
      displayEmail: loginEmail,
      whatsapp,
      phone,
      sortOrder: m.index,
      account: 'skipped',
      accountId: null,
      contact: 'skipped',
      contactId: null,
      initialPassword: null,
    };
    rows.push(row);

    const accountPayload = {
      name: row.displayName,
      email: loginEmail,
      jobTitle: undefined as string | undefined, // 旧站无职位，不编造
      roleIds: [salesRole.id],
      isActive: true,
    };

    const contactPayload = {
      adminUserId: '<accountId>',
      displayName: row.displayName,
      jobTitle: undefined as string | undefined,
      displayEmail: loginEmail,
      whatsapp: row.whatsapp ?? undefined,
      phone: row.phone ?? undefined,
      showOnSite: true,
      isLeadContact: false,
      sortOrder: row.sortOrder,
      internalNote: undefined as string | undefined,
    };

    console.log(
      `[${String(m.index).padStart(2, '0')}] ${row.displayName.padEnd(14)} ` +
        `wa=${(row.whatsapp ?? '—').padEnd(15)} tel=${(row.phone ?? '—').padEnd(15)} ${loginEmail}`,
    );
    if (!APPLY) {
      console.log(`     POST /cms/accounts  ${JSON.stringify(accountPayload)}`);
      console.log(`     PUT  /cms/contacts  ${JSON.stringify(contactPayload)}\n`);
      continue;
    }

    // ── 1. 创建账号 ───────────────────────────────────────
    try {
      const res = await call<CreateAccountResult>('/cms/accounts', {
        method: 'POST',
        token,
        body: JSON.stringify(accountPayload),
      });
      row.accountId = res.data!.account.id;
      row.account = 'created';
      row.initialPassword = res.data!.initialPassword;
      console.log(`     ✓ 账号已创建 ${row.accountId}`);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 409) {
        // 已存在 → 复用它（幂等重跑）
        const listRes = await call<{ items: { id: string; email: string }[] }>(
          `/cms/accounts?keyword=${encodeURIComponent(loginEmail)}&limit=10`,
          { token },
        );
        const found = (listRes.data?.items ?? []).find((i) => i.email === loginEmail);
        if (!found) throw new Error(`账号 ${loginEmail} 已存在（409）但查询不到，请人工核对`);
        row.accountId = found.id;
        row.account = 'reused';
        console.log(`     = 账号已存在，复用 ${row.accountId}`);
        // 复用账号没有本次创建时返回的一次性口令 → 重置口令以取得可交付凭据
        try {
          const pwRes = await call<{ initialPassword: string }>(
            `/cms/accounts/${found.id}/reset-password`,
            { method: 'POST', token, body: JSON.stringify({}) },
          );
          row.initialPassword = pwRes.data!.initialPassword;
          console.log(`     ↺ 口令已重置（用于交付明文凭据）`);
        } catch (err) {
          console.log(`     ! 口令重置失败，需人工分发：${(err as Error).message}`);
        }
      } else {
        row.account = 'failed';
        row.error = e.message;
        console.log(`     ✗ 账号创建失败：${e.message}`);
        continue;
      }
    }

    if (!row.accountId) continue;

    // ── 2. upsert 联系方式 ────────────────────────────────
    try {
      const res = await call<{ id: string }>('/cms/contacts', {
        method: 'PUT',
        token,
        body: JSON.stringify({ ...contactPayload, adminUserId: row.accountId }),
      });
      row.contactId = res.data!.id;
      row.contact = 'updated'; // PUT 语义：创建或更新，具体由后端判定
      console.log(`     ✓ 联系方式已写入 ${row.contactId}`);
    } catch (err) {
      const e = err as Error;
      row.contact = 'failed';
      row.error = e.message;
      console.log(`     ✗ 联系方式写入失败：${e.message}`);
    }
  }

  // ── 报告 ────────────────────────────────────────────────
  writeFileSync(resolve(OUT_REPORT), JSON.stringify(rows, null, 2) + '\n', 'utf8');

  const created = rows.filter((r) => r.account === 'created').length;
  const reused = rows.filter((r) => r.account === 'reused').length;
  const contactOk = rows.filter((r) => r.contact === 'updated').length;
  const failed = rows.filter((r) => r.account === 'failed' || r.contact === 'failed');

  console.log(`\n──── 汇总 ────`);
  console.log(`账号：新建 ${created} / 复用 ${reused} / 失败 ${rows.filter((r) => r.account === 'failed').length}`);
  console.log(`联系方式：成功 ${contactOk} / 失败 ${rows.filter((r) => r.contact === 'failed').length}`);
  console.log(`报告：${OUT_REPORT}`);

  if (APPLY) {
    const creds = rows
      .filter((r) => r.initialPassword)
      .map((r) => ({
        email: r.loginEmail,
        name: r.displayName,
        password: r.initialPassword,
        account: r.account,
      }));
    if (creds.length > 0) {
      writeFileSync(
        resolve(OUT_CREDENTIALS),
        JSON.stringify(
          {
            warning: '一次性明文口令，仅本次创建/重置响应可见。请分发给员工并让本人立即修改，随后删除本文件。',
            generatedAt: new Date().toISOString(),
            credentials: creds,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      console.log(`凭据：${OUT_CREDENTIALS}（已加入 .gitignore，分发后请删除）`);
    }
  }

  if (failed.length > 0) {
    console.log(`\n失败明细：`);
    for (const f of failed) console.log(`  - [${f.index}] ${f.displayName}：${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\n导入中断：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
