/**
 * IP 脱敏（访客统计实现规格 10.2）。
 *
 * ⚠️ 2026-10-27 口径变更：原「完整 IP 永不落库」的红线**已按业务要求放开**，
 * 现状是**双轨存储**，两者职责不同，不要合并：
 *
 *   · `visitor_session.maskedIp` —— 本文件产出，存脱敏网段，只用于 UV/PV 去重
 *     与会话归并；聚合口径永远基于网段，不受完整 IP 影响。
 *   · `visitor_ip_log.ip` —— 存完整 IP 原文，供后台「近期访客 IP」查看来源国家；
 *     固定保留 30 天，由 VisitorIpCleanupWorker 自动删除（超期即物理删除）。
 *
 * 因此：完整 IP 现在**会**落库，但只落 `visitor_ip_log`，且必须有保留期；
 * 其余任何表、任何日志、任何对外接口都仍不得出现完整 IP。
 *
 *   · IPv4        203.0.113.47        → 203.0.113.0/24
 *   · IPv6        2001:db8:85a3::1    → 2001:db8:85a3::/48
 *   · IPv4-mapped ::ffff:203.0.113.47 → 203.0.113.0/24（先剥前缀按 IPv4 处理）
 *
 * 非法输入返回 null，不抛错。
 */

/** IPv4 四段点分十进制（不含前导零歧义，宽松允许 0-255 之外由调用方保证仅是格式） */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4-mapped IPv6 前缀 */
const V4_MAPPED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** 单个 IPv6 组（1-4 位十六进制） */
const HE_GROUP = '[0-9a-fA-F]{1,4}';

/**
 * 粗判是否「像 IPv6」：含至少两个冒号分组、或含 '::'。
 * 只用于分流，合法性由精确展开判断。
 */
function looksLikeIPv6(input: string): boolean {
  return input.includes(':') && (input.includes('::') || input.split(':').filter(Boolean).length >= 3);
}

/** 剥掉 IPv6 zone id（fe80::1%eth0 → fe80::1） */
function stripZoneId(input: string): string {
  const percent = input.indexOf('%');
  return percent === -1 ? input : input.slice(0, percent);
}

/**
 * 把 IPv6 展开为 8 个 16 位组（数字数组），支持 '::' 压缩。
 * 非法格式返回 null。
 */
function expandIPv6(input: string): number[] | null {
  const text = stripZoneId(input.trim());
  if (text.length === 0) return null;

  // '::' 最多出现一次
  const doubleColonCount = (text.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  const isGroup = (part: string): boolean =>
    part.length > 0 && new RegExp(`^${HE_GROUP}$`).test(part);

  let head: string[] = [];
  let tail: string[] = [];
  if (doubleColonCount === 1) {
    const [left, right] = text.split('::');
    head = left ? left.split(':') : [];
    tail = right ? right.split(':') : [];
    if (!head.every(isGroup) || !tail.every(isGroup)) return null;
  } else {
    const parts = text.split(':');
    if (parts.length !== 8 || !parts.every(isGroup)) return null;
    head = parts;
    tail = [];
  }

  const groups: number[] = [];
  for (const part of head) groups.push(parseInt(part, 16));
  const fill = 8 - groups.length - tail.length;
  if (doubleColonCount === 1 ? fill < 0 : fill !== 0) return null;
  for (let i = 0; i < fill; i += 1) groups.push(0);
  for (const part of tail) groups.push(parseInt(part, 16));

  return groups.length === 8 ? groups : null;
}

/** 8 组 → 压缩表示（前 3 组后全零时输出 `a:b:c::`） */
function groupsToPrefix48(groups: number[]): string {
  const kept = groups.slice(0, 3).map((g) => g.toString(16));
  return `${kept.join(':')}::/48`;
}

/**
 * 脱敏入口。返回脱敏网段字符串；无法解析返回 null（不抛错）。
 */
export function anonymizeIp(rawIp: string | null | undefined): string | null {
  if (rawIp === null || rawIp === undefined) return null;
  const trimmed = rawIp.trim();
  if (trimmed.length === 0) return null;

  // 1) IPv4-mapped IPv6：::ffff:203.0.113.47 → 按 IPv4 处理
  const mapped = V4_MAPPED_RE.exec(trimmed);
  if (mapped) {
    return maskIPv4(mapped[1]!);
  }

  // 2) IPv4
  const v4 = IPV4_RE.exec(trimmed);
  if (v4) {
    return maskIPv4(trimmed);
  }

  // 3) IPv6
  if (looksLikeIPv6(trimmed)) {
    const groups = expandIPv6(trimmed);
    if (groups) {
      return groupsToPrefix48(groups);
    }
    return null;
  }

  return null;
}

/** IPv4：保留前 3 段，末段归 0，加 /24。段值 >255 视为非法返回 null。 */
function maskIPv4(ip: string): string | null {
  const match = IPV4_RE.exec(ip.trim());
  if (!match) return null;
  const [a, b, c] = [match[1]!, match[2]!, match[3]!];
  for (const octet of [a, b, c]) {
    const value = Number.parseInt(octet, 10);
    if (value < 0 || value > 255) return null;
  }
  return `${Number.parseInt(a, 10)}.${Number.parseInt(b, 10)}.${Number.parseInt(c, 10)}.0/24`;
}
