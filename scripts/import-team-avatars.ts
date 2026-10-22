/**
 * 旧站员工头像迁移（Phase 5.4）—— 全部走 CMS 接口，不直连数据库。
 *
 * 数据源：docs/migration/legacy-raw/legacy-team-contacts.json 的 photoUrl
 *
 * 流程：
 *   1. POST /auth/login 取 token
 *   2. GET  /cms/contacts 取「登录邮箱 → 联系方式」映射（含 contactId 与当前 avatarUrl）
 *   3. 下载旧站头像（webp）→ PUT /cms/contacts/:id/avatar（multipart，字段 file）
 *
 * 存储位置由后端 STORAGE_PROVIDER 决定（当前 LOCAL，落 <cwd>/uploads/media）；
 * 切换到 COS 后本脚本无需任何改动——StorageProvider 对上层透明。
 *
 * 用法：
 *   ts-node scripts/import-team-avatars.ts            # dry-run，只打印将上传的头像
 *   ts-node scripts/import-team-avatars.ts --apply    # 实际下载并上传
 *   ts-node scripts/import-team-avatars.ts --apply --force   # 已有头像也强制重传
 *
 * 幂等：已设置 avatarUrl 的员工默认跳过；--force 会重新上传（服务端会删除旧对象）。
 */
import 'dotenv/config';
import { resolve } from 'node:path';

const API = process.env.IMPORT_API_BASE ?? 'http://127.0.0.1:4000/api/v1';
const SRC = 'docs/migration/legacy-raw/legacy-team-contacts.json';
const OUT_REPORT = 'docs/migration/legacy-raw/team-avatar-import-report.json';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

/** 旧站头像 CDN 偶发超时，单独放宽超时并重试 */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_RETRIES = 3;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

interface LegacyMember {
  index: number;
  name: string;
  email: string;
  photoUrl: string;
}

interface ContactRow {
  id: string;
  displayName: string;
  displayEmail: string | null;
  avatarUrl: string | null;
  employee: { email: string };
}

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
    ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
  };
  // multipart 时不要手动设 Content-Type：fetch 会自行带上 boundary
  if (!(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  let body: Envelope<T>;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}，非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || body.success === false) {
    const err = new Error(
      `${init.method ?? 'GET'} ${path} → ${body.error?.message ?? `HTTP ${res.status}`}`,
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return body;
}

/** 按 photoUrl 后缀推断 MIME（只可能是 webp，这里做保守映射） */
function mimeFromUrl(url: string): string {
  const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase();
  if (ext === 'webp') return 'image/webp';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  throw new Error(`无法识别的头像扩展名: ${url}`);
}

async function downloadWithRetry(url: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = err;
      console.log(`     下载重试 ${attempt}/${DOWNLOAD_RETRIES}：${(err as Error).message}`);
    }
  }
  throw new Error(`下载失败（${url}）：${(lastError as Error)?.message ?? 'unknown'}`);
}

interface RowResult {
  index: number;
  displayName: string;
  contactId: string | null;
  photoUrl: string;
  bytes: number | null;
  action: 'uploaded' | 'skipped' | 'downloaded-only' | 'failed';
  avatarUrl?: string | null;
  error?: string;
}

async function main(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) throw new Error('缺少 ADMIN_EMAIL / ADMIN_PASSWORD（.env）');

  const members: LegacyMember[] = JSON.parse(
    (await import('node:fs')).readFileSync(resolve(SRC), 'utf8'),
  );
  console.log(`\n数据源：${SRC}（${members.length} 位员工）`);
  console.log(`模式：${APPLY ? 'APPLY（实际下载+上传）' : 'DRY-RUN（不下载不写入）'}${FORCE ? ' + FORCE（已有头像也重传）' : ''}\n`);

  const login = await call<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const token = login.data?.accessToken;
  if (!token) throw new Error('登录响应缺少 accessToken');
  console.log(`已登录：${adminEmail}`);

  const listRes = await call<{ items: ContactRow[]; total: number }>('/cms/contacts', { token });
  const byEmail = new Map<string, ContactRow>();
  for (const c of listRes.data?.items ?? []) {
    byEmail.set(c.employee.email.toLowerCase(), c);
  }
  console.log(`后台联系方式：${listRes.data?.items?.length ?? 0} 条\n`);

  const rows: RowResult[] = [];

  for (const m of members) {
    const email = m.email.trim().toLowerCase();
    const contact = byEmail.get(email);
    const row: RowResult = {
      index: m.index,
      displayName: m.name,
      contactId: contact?.id ?? null,
      photoUrl: m.photoUrl,
      bytes: null,
      action: 'failed',
    };
    rows.push(row);

    console.log(`[${String(m.index).padStart(2, '0')}] ${m.name.padEnd(14)} ${email}`);
    if (!contact) {
      row.error = '未找到对应联系方式（账号可能未导入）';
      console.log(`     ✗ ${row.error}`);
      continue;
    }

    if (contact.avatarUrl && !FORCE) {
      row.action = 'skipped';
      row.avatarUrl = contact.avatarUrl;
      console.log(`     = 已有头像，跳过（${contact.avatarUrl}）`);
      continue;
    }

    if (!APPLY) {
      row.action = 'downloaded-only';
      console.log(`     → 将下载 ${m.photoUrl.split('/').pop()} 并 PUT /cms/contacts/${contact.id}/avatar`);
      continue;
    }

    try {
      const buffer = await downloadWithRetry(m.photoUrl);
      row.bytes = buffer.length;
      console.log(`     下载完成 ${buffer.length} 字节`);

      const form = new FormData();
      // Buffer → Uint8Array：Buffer 的 buffer 是 ArrayBufferLike（可能是 SharedArrayBuffer），
      // 不能直接作为 BlobPart；拷贝成独立 Uint8Array 后类型与语义都干净。
      const bytes = new Uint8Array(buffer.byteLength);
      buffer.copy(bytes);
      form.append('file', new Blob([bytes], { type: mimeFromUrl(m.photoUrl) }), `avatar-${m.index}.webp`);

      const res = await call<ContactRow>(`/cms/contacts/${contact.id}/avatar`, {
        method: 'PUT',
        token,
        body: form,
      });
      row.action = 'uploaded';
      row.avatarUrl = res.data?.avatarUrl ?? null;
      console.log(`     ✓ 头像已上传 → ${row.avatarUrl}`);
    } catch (err) {
      row.error = (err as Error).message;
      console.log(`     ✗ ${row.error}`);
    }
  }

  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(OUT_REPORT), JSON.stringify(rows, null, 2) + '\n', 'utf8');

  const uploaded = rows.filter((r) => r.action === 'uploaded').length;
  const skipped = rows.filter((r) => r.action === 'skipped').length;
  const failed = rows.filter((r) => r.action === 'failed');

  console.log(`\n──── 汇总 ────`);
  console.log(`上传成功 ${uploaded} / 已有跳过 ${skipped} / 失败 ${failed.length}`);
  console.log(`报告：${OUT_REPORT}`);

  if (failed.length) {
    console.log(`\n失败明细：`);
    for (const f of failed) console.log(`  - [${f.index}] ${f.displayName}：${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\n迁移中断：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
