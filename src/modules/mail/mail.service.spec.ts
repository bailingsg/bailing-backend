import { ConfigService } from '@nestjs/config';
import { MailService, normalizeEmails } from './mail.service';

/** 构造带指定配置的 MailService（不真正连接 SMTP）；键为 configuration.ts 的小驼峰配置键 */
function makeService(overrides: Record<string, string> = {}): MailService {
  const values: Record<string, string> = {
    smtpHost: 'smtp.163.com',
    smtpPort: '465',
    smtpUser: 'sender@163.com',
    smtpPassword: 'auth-code',
    mailFromName: 'Bailing Wooden Website',
    inquiryNotifyEmail: '',
    ...overrides,
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new MailService(config);
}

describe('MailService', () => {
  describe('isEnabled', () => {
    it('SMTP 三要素齐全时启用', () => {
      expect(makeService().isEnabled()).toBe(true);
    });

    it('缺任一要素时禁用（降级为不发信）', () => {
      expect(makeService({ smtpPassword: '' }).isEnabled()).toBe(false);
      expect(makeService({ smtpUser: '' }).isEnabled()).toBe(false);
      expect(makeService({ smtpHost: '' }).isEnabled()).toBe(false);
    });
  });

  describe('收件人解析', () => {
    it('INQUIRY_NOTIFY_EMAIL 配置了兜底邮箱时优先使用', () => {
      const service = makeService({ inquiryNotifyEmail: 'boss@qq.com' });
      expect(service.notifyRecipients()).toEqual(['boss@qq.com']);
      expect(service.fallbackRecipients()).toEqual(['boss@qq.com']);
    });

    it('未配置兜底邮箱时退化为发件邮箱自身', () => {
      const service = makeService({ inquiryNotifyEmail: '' });
      expect(service.notifyRecipients()).toEqual([]);
      expect(service.fallbackRecipients()).toEqual(['sender@163.com']);
    });

    it('兜底邮箱支持逗号分隔多个并去空白/去重', () => {
      const service = makeService({ inquiryNotifyEmail: ' a@qq.com , b@qq.com ,a@qq.com ' });
      expect(service.fallbackRecipients()).toEqual(['a@qq.com', 'b@qq.com']);
    });
  });

  describe('sendInquiryNotification 降级路径', () => {
    it('SMTP 未配置时返回 disabled，不抛错', async () => {
      const service = makeService({ smtpPassword: '' });
      const result = await service.sendInquiryNotification({ to: ['x@qq.com'] }, dummyPayload());
      expect(result).toMatchObject({ sent: false, reason: 'disabled' });
    });

    it('收件人全部非法时返回 no-recipient', async () => {
      const service = makeService();
      const result = await service.sendInquiryNotification({ to: ['not-an-email'] }, dummyPayload());
      expect(result).toMatchObject({ sent: false, reason: 'no-recipient' });
    });

    it('发送成功时返回 messageId（transporter 以最小桩替换）', async () => {
      const service = makeService();
      (service as unknown as { transporter: unknown }).transporter = {
        sendMail: jest.fn().mockResolvedValue({ messageId: '<test@163.com>' }),
      };
      const result = await service.sendInquiryNotification(
        { to: ['sales@qq.com'], cc: ['sales@qq.com'] }, // cc 与 to 重复应被过滤
        dummyPayload(),
      );
      expect(result).toMatchObject({ sent: true, messageId: '<test@163.com>' });
    });

    it('SMTP 报错时返回 error 且不抛出（询盘不因邮件失败而失败）', async () => {
      const service = makeService();
      (service as unknown as { transporter: unknown }).transporter = {
        sendMail: jest.fn().mockRejectedValue(new Error('550 auth failed')),
      };
      const result = await service.sendInquiryNotification({ to: ['sales@qq.com'] }, dummyPayload());
      expect(result).toMatchObject({ sent: false, reason: 'error' });
      expect(result.error).toContain('550');
    });
  });

  describe('normalizeEmails', () => {
    it('过滤非法地址并去重（大小写不敏感）', () => {
      expect(normalizeEmails(['A@QQ.com', 'a@qq.com', 'bad', '', 'b@qq.com'])).toEqual([
        'A@QQ.com',
        'b@qq.com',
      ]);
    });
  });
});

function dummyPayload() {
  return {
    rfqId: 'rfq-test-1',
    name: 'Michael Chen',
    company: 'Pacific Timber',
    email: 'buyer@example.com',
    phone: null,
    country: 'Singapore',
    productName: 'Birch Plywood 18mm',
    quantity: '4 x 40HQ',
    message: 'Please quote.',
    attachmentUrl: null,
    status: 'NEW',
    createdAt: new Date('2026-10-17T08:00:00Z'),
    assigneeName: 'wangm',
    sourceIp: null,
    userAgent: null,
  };
}
