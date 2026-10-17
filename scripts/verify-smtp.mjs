/**
 * SMTP 连通性与发信自检脚本。
 *
 * 用途：配置完 .env 的 SMTP_* 后，无需启动整个后端即可确认
 * 「授权码是否正确 / 465 端口是否可用 / 能否真的发出邮件」。
 *
 * 用法：
 *   node scripts/verify-smtp.mjs                 # 自检 + 发一封测试邮件到发件箱自身
 *   node scripts/verify-smtp.mjs someone@xx.com  # 自检 + 发到指定邮箱
 */
import { config } from 'dotenv';
import nodemailer from 'nodemailer';

config();

const host = (process.env.SMTP_HOST ?? '').trim();
const port = Number(process.env.SMTP_PORT ?? 465);
const user = (process.env.SMTP_USER ?? '').trim();
const pass = process.env.SMTP_PASSWORD ?? '';
const secure = (process.env.SMTP_SECURE ?? 'true') === 'true';
const overrideTo = process.argv[2];

if (!host || !user || !pass) {
  console.error('× SMTP 配置不完整：SMTP_HOST / SMTP_USER / SMTP_PASSWORD 必须同时配置');
  process.exit(1);
}

console.log(`SMTP: ${user} @ ${host}:${port} (secure=${secure})`);

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
  tls: { rejectUnauthorized: false },
});

try {
  await transporter.verify();
  console.log('✓ SMTP 登录验证通过（授权码有效）');
} catch (error) {
  console.error(`× SMTP 登录验证失败：${error.message}`);
  console.error('  常见原因：授权码填错 / 未开启 SMTP 服务 / 端口被防火墙拦截');
  process.exit(1);
}

const to = overrideTo ?? user;
const info = await transporter.sendMail({
  from: `"Bailing Wooden Website" <${user}>`,
  to,
  subject: '【百灵木业】询盘邮件通道自检',
  text: `这是一封自检邮件，用于确认官网询盘邮件通道可用。\n发件账号：${user}`,
  html: `<p>这是一封自检邮件，用于确认官网询盘邮件通道可用。</p><p>发件账号：${user}</p>`,
});

console.log(`✓ 测试邮件已发送 → ${to}`);
console.log(`  messageId: ${info.messageId}`);
console.log(`  response : ${info.response}`);
