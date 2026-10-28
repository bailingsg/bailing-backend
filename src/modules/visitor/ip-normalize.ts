/**
 * IP 规范化（落库与 GeoIP 查询共用的唯一入口）。
 *
 * 为什么必须统一：同一个客户端在不同代理链路下会以三种形态出现，
 * 不归一化会让「同一台机器」在库里变成三条互不相干的记录：
 *
 *   1. IPv4-mapped IPv6：`::ffff:203.0.113.47`（Node 在双栈监听时的常见形态）
 *   2. 带 zone id 的链路本地地址：`fe80::1%eth0`
 *   3. 带端口的写法：`203.0.113.47:53211`（XFF 里偶见）
 *
 * 本函数只做「清洗 + 合法性校验」，**不做任何脱敏**——脱敏在 ip-anonymize.ts。
 * 两者不可合并：脱敏后的值不能再用来查 GeoIP。
 */

/** IPv4 四段点分 */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4-mapped IPv6（大小写不敏感） */
const V4_MAPPED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** IPv6 字面量：只含十六进制与冒号（合法性由长度与 mmdb 查询兜底） */
const IPV6_LITERAL_RE = /^[0-9a-fA-F:]+$/;

/** 存储列的长度上限（IPv6 最长 45：8 组 × 4 + 7 个冒号，含 IPv4-mapped 形态） */
const MAX_IP_LENGTH = 45;

/**
 * 规范化 IP。返回可直接落库 / 可直接查 GeoIP 的字符串；无法识别返回 null。
 *
 *   `::ffff:203.0.113.47` → `203.0.113.47`
 *   `fe80::1%eth0`        → `fe80::1`
 *   `203.0.113.047`       → `203.0.113.47`（去掉前导零）
 *   `unknown` / `` / 超长 → null
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let ip = raw.trim();
  if (ip.length === 0) return null;

  // 剥 zone id（fe80::1%eth0）
  const percent = ip.indexOf('%');
  if (percent !== -1) ip = ip.slice(0, percent);

  // 剥 IPv4-mapped 前缀后按 IPv4 处理
  const mapped = V4_MAPPED_RE.exec(ip);
  if (mapped) return canonicalIpv4(mapped[1]!);

  const v4 = IPV4_RE.exec(ip);
  if (v4) return canonicalIpv4(ip);

  // IPv6：含冒号且只含十六进制字符；长度上限兜底
  if (ip.includes(':') && IPV6_LITERAL_RE.test(ip) && ip.length <= MAX_IP_LENGTH) {
    return ip.toLowerCase();
  }

  return null;
}

/** IPv4 去前导零 + 段值校验（>255 视为非法） */
function canonicalIpv4(ip: string): string | null {
  const match = IPV4_RE.exec(ip);
  if (!match) return null;
  const octets: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const value = Number.parseInt(match[i]!, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets.join('.');
}
