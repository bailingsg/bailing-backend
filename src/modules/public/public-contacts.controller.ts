import { Controller, Get, Query } from '@nestjs/common';
import { ContactsService } from '../cms/contacts/contacts.service';
import type { PublicContactDto } from '../cms/contacts/entities/contact.entity';

/**
 * 员工联系方式公开 API（Phase 4.6，只读，无需登录）。
 *
 *   GET /api/v1/public/contacts              已公开展示的员工联系方式列表
 *   GET /api/v1/public/contacts?leadOnly=1   其中「可接单」的那部分（询盘联系人）
 *
 * 数据诚实约束（规格逐条）：
 *   · **只**返回 showOnSite=true 且员工账号启用中的记录
 *   · **绝不**返回 internalNote（内部备注）、adminUserId、账号登录邮箱
 *   · 停用员工不会出现在结果中（即使其 showOnSite 尚未同步）
 *
 * leadOnly 供「关于页 · 订单背后的人」使用：可接单 = 账号启用 + 勾选「询盘联系人」，
 * 与询盘轮转的准入判定逐条一致，避免两处各写一套规则后走偏。
 */
@Controller('public/contacts')
export class PublicContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  list(@Query('leadOnly') leadOnly?: string): Promise<PublicContactDto[]> {
    // 只有明确的 true/1 才收窄结果；其它任何值（含空）一律按全量返回，
    // 避免 ?leadOnly=false 被当成真值把前台联系页的员工全部过滤掉。
    const normalized = (leadOnly ?? '').trim().toLowerCase();
    return this.contactsService.listPublic({
      leadOnly: normalized === 'true' || normalized === '1',
    });
  }
}
