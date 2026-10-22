import { IsUUID } from 'class-validator';

/**
 * 访客上报请求体（访客统计实现规格 4.1）。
 *
 * 硬约束：
 *   · visitorId 必须是 UUID v4（前端生成，存 localStorage）；
 *   · 多传任何字段一律 400——全局 ValidationPipe 已开
 *     `whitelist + forbidNonWhitelisted`（app.setup.ts），
 *     未声明字段被显式拒绝而非静默丢弃（规格 10.5）；
 *   · 请求体只允许这一个字段：不发路径 / 商品 / 账户 / UA（UA 后端从 header 取）。
 */
export class TrackVisitorDto {
  @IsUUID('4', { message: 'visitorId 必须是合法的 UUID v4' })
  visitorId!: string;
}
