import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * 询盘通知邮件要投递的一条线索内容。
 *
 * 只承载询盘本身与客户联系信息；不含任何后端内部字段（如 storageKey）。
 */
export interface InquiryMailPayload {
  rfqId: string;
  name: string;
  company: string;
  email: string;
  phone: string | null;
  country: string;
  productName: string | null;
  quantity: string | null;
  message: string;
  attachmentUrl: string | null;
  status: string;
  createdAt: Date;
  /** 承接业务员姓名（未分配时为 null） */
  assigneeName: string | null;
  /** 风控字段：来源 IP / UA（邮件中仅内部可见） */
  sourceIp?: string | null;
  userAgent?: string | null;
}

export interface MailRecipients {
  /** 主收件人（至少 1 个） */
  to: string[];
  /** 抄送（可为空） */
  cc?: string[];
}

export interface SendResult {
  sent: boolean;
  /** 未发送的原因（disabled / no-recipient / error） */
  reason?: 'disabled' | 'no-recipient' | 'error';
  messageId?: string;
  error?: string;
}

/**
 * 邮件发送服务（询盘通知）。
 *
 * 设计原则：
 *   · **绝不阻断主流程**：SMTP 未配置 / 发送失败只记日志，询盘照常入库，销售线索不丢。
 *   · **凭据只从配置读**：不写日志、不进响应体（错误日志只记 message，不含口令）。
 *   · **HTML + 纯文本双版本**：兼容 Outlook / 手机客户端等不渲染 HTML 的收件端。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  /** SMTP 是否完整配置（决定发信还是降级） */
  isEnabled(): boolean {
    const host = this.config.get<string>('smtpHost')?.trim();
    const user = this.config.get<string>('smtpUser')?.trim();
    const password = this.config.get<string>('smtpPassword')?.trim();
    return Boolean(host && user && password);
  }

  /** 懒创建并复用 transporter（避免每封邮件重新握手） */
  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const host = (this.config.get<string>('smtpHost') ?? '').trim();
    const port = Number(this.config.get<number>('smtpPort') ?? 465);
    const explicitSecure = this.config.get<string>('smtpSecure');
    const secure =
      explicitSecure !== undefined && explicitSecure !== ''
        ? explicitSecure === 'true'
        : port === 465;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user: (this.config.get<string>('smtpUser') ?? '').trim(),
        pass: this.config.get<string>('smtpPassword') ?? '',
      },
      // 发送失败要快速失败，不能拖慢访客提交询盘的响应
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      // 163 / QQ 等国内服务商常使用自签或过期证书链，仅在本服务内放宽校验
      tls: { rejectUnauthorized: false },
    });

    return this.transporter;
  }

  /**
   * 后台显式配置的询盘通知邮箱（INQUIRY_NOTIFY_EMAIL，逗号分隔）。
   * 未配置时返回空数组——用于「有承接人时是否抄送」的判断。
   */
  notifyRecipients(): string[] {
    return normalizeEmails((this.config.get<string>('inquiryNotifyEmail') ?? '').split(','));
  }

  /**
   * 兜底收件人：询盘没有承接人时收件人取这里。
   * 优先 INQUIRY_NOTIFY_EMAIL；未配置时退化为发件邮箱自身（保证线索至少有一封邮件可追溯）。
   */
  fallbackRecipients(): string[] {
    const configured = this.notifyRecipients();
    if (configured.length > 0) return configured;
    return normalizeEmails([this.config.get<string>('smtpUser') ?? '']);
  }

  /** 连通性自检（供启动脚本与联调脚本使用） */
  async verify(): Promise<boolean> {
    if (!this.isEnabled()) return false;
    try {
      await this.getTransporter().verify();
      return true;
    } catch (error) {
      this.logger.error(
        `SMTP 连通性自检失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 发送询盘通知邮件。
   *
   * 收件人由调用方（RfqService）决定：优先承接业务员，无承接人时走兜底邮箱。
   * Reply-To 设为**客户邮箱**，业务员在邮件客户端点「回复」即可直接联系客户。
   */
  async sendInquiryNotification(
    recipients: MailRecipients,
    payload: InquiryMailPayload,
  ): Promise<SendResult> {
    if (!this.isEnabled()) {
      this.logger.warn('SMTP 未完整配置：跳过询盘邮件通知（询盘已入库）。');
      return { sent: false, reason: 'disabled' };
    }

    const to = normalizeEmails(recipients.to);
    if (to.length === 0) return { sent: false, reason: 'no-recipient' };

    const cc = normalizeEmails(recipients.cc ?? []).filter((mail) => !to.includes(mail));
    const fromName = (this.config.get<string>('mailFromName') ?? 'Bailing Wooden Website').trim();
    const fromAddress = (this.config.get<string>('smtpUser') ?? '').trim();
    const subject =
      `【新询盘】${payload.company || payload.name}` +
      (payload.productName ? ` - ${payload.productName}` : '') +
      `（${payload.country}）`;

    try {
      const info = await this.getTransporter().sendMail({
        from: `"${fromName}" <${fromAddress}>`,
        to: to.join(', '),
        cc: cc.length > 0 ? cc.join(', ') : undefined,
        replyTo: payload.email,
        subject,
        text: buildTextBody(payload),
        html: buildHtmlBody(payload),
      });

      this.logger.log(`询盘 ${payload.rfqId} 邮件通知已发送至 ${to.join(', ')}（cc: ${cc.length}）`);
      return { sent: true, messageId: info.messageId };
    } catch (error) {
      // 仅记录错误消息：nodemailer 的 message 不含 auth.pass，但为稳妥起见不打印整个配置对象
      this.logger.error(
        `询盘 ${payload.rfqId} 邮件通知发送失败（询盘已入库，可在后台查看）：` +
          (error instanceof Error ? error.message : String(error)),
      );
      return {
        sent: false,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/* --------------------------------- 工具 --------------------------------- */

/** 清洗收件人列表：去空白、去重、丢弃非法地址 */
export function normalizeEmails(list: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of list) {
    const mail = (raw ?? '').trim();
    if (!mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) continue;
    const key = mail.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(mail);
  }
  return result;
}

/** HTML 转义：客户输入一律不可信，防止邮件正文被注入标签 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatField(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : '—';
}

function formatTime(date: Date): string {
  // 统一按北京时间展示，便于业务员直接判断线索时效
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function buildTextBody(payload: InquiryMailPayload): string {
  const lines = [
    `收到一条新的询盘（编号 ${payload.rfqId}）`,
    '',
    `客户姓名：${formatField(payload.name)}`,
    `公司名称：${formatField(payload.company)}`,
    `联系邮箱：${formatField(payload.email)}`,
    `联系电话：${formatField(payload.phone)}`,
    `国家/地区：${formatField(payload.country)}`,
    `意向产品：${formatField(payload.productName)}`,
    `预估数量：${formatField(payload.quantity)}`,
    `提交时间：${formatTime(payload.createdAt)}（北京时间）`,
    `当前状态：${payload.status}`,
    `承接业务员：${formatField(payload.assigneeName)}`,
    '',
    '采购需求：',
    payload.message,
  ];
  if (payload.attachmentUrl) {
    lines.push('', `附件：${payload.attachmentUrl}`);
  }
  lines.push('', '（本邮件由官网询盘系统自动发送，直接回复即可联系客户。）');
  return lines.join('\n');
}

function buildHtmlBody(payload: InquiryMailPayload): string {
  const rows: Array<[string, string]> = [
    ['客户姓名', formatField(payload.name)],
    ['公司名称', formatField(payload.company)],
    ['联系邮箱', formatField(payload.email)],
    ['联系电话', formatField(payload.phone)],
    ['国家 / 地区', formatField(payload.country)],
    ['意向产品', formatField(payload.productName)],
    ['预估数量', formatField(payload.quantity)],
    ['提交时间', `${formatTime(payload.createdAt)}（北京时间）`],
    ['当前状态', payload.status],
    ['承接业务员', formatField(payload.assigneeName)],
  ];

  const tableRows = rows
    .map(
      ([label, value]) =>
        `<tr><th style="text-align:left;padding:8px 12px;color:#5b6b7c;font-weight:600;` +
        `white-space:nowrap;background:#f6f8fa;border-bottom:1px solid #e6eaee;">${escapeHtml(label)}</th>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #e6eaee;color:#1f2d3d;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const attachment = payload.attachmentUrl
    ? `<p style="margin:14px 0 0;font-size:14px;color:#1f2d3d;">附件：<a href="${escapeHtml(
        payload.attachmentUrl,
      )}" style="color:#1a73e8;">${escapeHtml(payload.attachmentUrl)}</a></p>`
    : '';

  const source =
    payload.sourceIp || payload.userAgent
      ? `<p style="margin:14px 0 0;font-size:12px;color:#8899a6;">来源信息：${escapeHtml(
          [payload.sourceIp, payload.userAgent].filter(Boolean).join(' | '),
        )}</p>`
      : '';

  return `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(16,24,40,0.08);">
      <div style="padding:18px 24px;background:#8b5e3c;color:#ffffff;">
        <div style="font-size:18px;font-weight:700;">百灵木业 · 新询盘通知</div>
        <div style="font-size:13px;opacity:.9;margin-top:4px;">编号 ${escapeHtml(payload.rfqId)}</div>
      </div>
      <div style="padding:20px 24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${tableRows}
        </table>
        <div style="margin-top:20px;">
          <div style="font-size:14px;font-weight:700;color:#1f2d3d;margin-bottom:8px;">采购需求</div>
          <div style="padding:12px 14px;background:#fbfcfe;border:1px solid #e6eaee;border-radius:6px;color:#1f2d3d;font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(
            payload.message,
          )}</div>
        </div>
        ${attachment}
        ${source}
        <p style="margin:20px 0 0;font-size:13px;color:#5b6b7c;">
          本邮件由官网询盘系统自动发送，<strong>直接回复本邮件即可联系客户</strong>。
        </p>
      </div>
    </div>
  </body>
</html>`;
}
