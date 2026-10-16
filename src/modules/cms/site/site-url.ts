/**
 * 站内 URL 安全校验（Phase 4.7）。
 *
 * 使用方：
 *   · CMS 写入路径（NavItem.url / SiteSection.ctaUrl）——保存前强制校验，不合法直接 400
 *   · 公开 API 只透传已校验值；前台渲染时同样只信任本模块产出
 *
 * 规则（硬约束）：
 *   1. 站内相对路径：必须以 `/` 开头，且不得以 `//` 或 `/\` 开头
 *      （protocol-relative / 反斜杠会被浏览器当外跳处理）
 *   2. 外链：仅允许 `https:`（杜绝 http 混合内容）；`mailto:` / `tel:` 白名单放行
 *   3. 拒绝一切其他协议：javascript: / data: / vbscript: / file: / blob: …
 *   4. 先剔除不可见字符（控制符 / 空白 / DEL）再判协议，
 *      防 `java\tscript:` 之类拼接绕过
 *   5. 任何 URL 不得包含控制字符（防头注入 / 日志注入）
 *
 * 返回规范化后的 URL；不合法返回 null（由调用方决定 400 或忽略）。
 */

/** 允许的非 http(s) 协议（导航场景合法：邮件 / 电话） */
const ALLOWED_SPECIAL_SCHEMES = new Set(['mailto:', 'tel:']);

/** 去除不可见字符：浏览器解析 URL 时会忽略制表符/换行/NUL，必须先归一化再判协议 */
function stripInvisible(value: string): string {
  return value
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      // 去掉 C0 控制符、DEL 与所有空白（含全角空格之外的 Unicode 空白）
      return code > 0x20 && code !== 0x7f && !/\s/.test(ch);
    })
    .join('');
}

/** 是否包含任何控制字符（原始串，未归一化） */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * 校验并规范化一个站内 / 外链 URL。
 *
 * @returns 合法 URL；不合法返回 null
 */
export function normalizeSiteUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const original = raw.trim();
  if (original.length === 0) return null;
  if (original.length > 2048) return null;
  // 原始串含控制字符一律拒绝（即使归一化后看不出来）
  if (hasControlChars(original)) return null;

  const value = stripInvisible(original);
  if (value.length === 0) return null;

  // ── 协议判定 ────────────────────────────────────────────
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'https') return value;
    if (ALLOWED_SPECIAL_SCHEMES.has(`${scheme}:`)) return value;
    return null; // http / javascript / data / vbscript / file / blob … 全部拒绝
  }

  // ── 站内相对路径 ────────────────────────────────────────
  // 必须以 / 开头；`//evil.com` 与 `/\evil.com` 都是外跳，拒绝
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value.startsWith('/')) return value;

  // 既不是绝对 URL 也不是以 / 开头的路径：拒绝（避免把 bare host
  // 如 `evil.com` 当相对路径落地，造成歧义与钓鱼风险）
  return null;
}

/** 便捷判定：是否合法（不含规范化返回） */
export function isSafeSiteUrl(raw: string): boolean {
  return normalizeSiteUrl(raw) !== null;
}
