import { anonymizeIp } from './ip-anonymize';

/**
 * IP 脱敏单测（访客统计实现规格 10.2 / 验收 12.4 的 26/27/28 与边界）。
 */

describe('anonymizeIp（IP 脱敏）', () => {
  it('IPv4：保留前 3 段，末段归 0，加 /24', () => {
    expect(anonymizeIp('203.0.113.47')).toBe('203.0.113.0/24');
    expect(anonymizeIp('8.8.8.8')).toBe('8.8.8.0/24');
  });

  it('IPv6：保留前 3 组，其余归 0，加 /48', () => {
    expect(anonymizeIp('2001:db8:85a3::1')).toBe('2001:db8:85a3::/48');
    expect(anonymizeIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::/48');
  });

  it('IPv4-mapped IPv6：先剥 ::ffff: 前缀按 IPv4 处理', () => {
    expect(anonymizeIp('::ffff:203.0.113.47')).toBe('203.0.113.0/24');
  });

  it('IPv6 zone id 被剥离', () => {
    expect(anonymizeIp('fe80::1%eth0')).toBe('fe80:0:0::/48');
  });

  it('非法输入返回 null，不抛错', () => {
    expect(anonymizeIp('not-an-ip')).toBeNull();
    expect(anonymizeIp('999.1.1.1')).toBeNull(); // 段值 > 255
    expect(anonymizeIp('2001::db8::1')).toBeNull(); // 双冒号出现两次
    expect(anonymizeIp('')).toBeNull();
    expect(anonymizeIp(null)).toBeNull();
    expect(anonymizeIp(undefined)).toBeNull();
  });
});
