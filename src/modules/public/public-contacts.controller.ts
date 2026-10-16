import { Controller, Get } from '@nestjs/common';
import { ContactsService } from '../cms/contacts/contacts.service';
import type { PublicContactDto } from '../cms/contacts/entities/contact.entity';

/**
 * 员工联系方式公开 API（Phase 4.6，只读，无需登录）。
 *
 *   GET /api/v1/public/contacts    已公开展示的员工联系方式列表
 *
 * 数据诚实约束（规格逐条）：
 *   · **只**返回 showOnSite=true 且员工账号启用中的记录
 *   · **绝不**返回 internalNote（内部备注）、adminUserId、账号登录邮箱
 *   · 停用员工不会出现在结果中（即使其 showOnSite 尚未同步）
 *
 * 该接口供前台后续消费；本阶段不改动前台 Contact 页面本身。
 */
@Controller('public/contacts')
export class PublicContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  list(): Promise<PublicContactDto[]> {
    return this.contactsService.listPublic();
  }
}
