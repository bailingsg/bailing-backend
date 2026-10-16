import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { RbacService } from '../../rbac/rbac.service';
import { toActorContext, type ActorContext } from '../../rbac/actor-context';
import type { AuthUser } from '../../auth/auth.types';
import { ContactsService } from './contacts.service';
import { ListContactsQueryDto, UpsertContactDto } from './dto/contact.dto';
import type { ContactDto, ContactListDto } from './entities/contact.entity';

/** 切换公开展示的请求体 */
class SetShowOnSiteDto {
  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean({ message: 'showOnSite 必须为布尔值' })
  showOnSite!: boolean;
}

/**
 * 员工联系方式 CMS API（Phase 4.6）。
 *
 *   GET    /api/v1/cms/contacts                          列表（contacts.read）
 *   GET    /api/v1/cms/contacts/:id                      详情（contacts.read）
 *   GET    /api/v1/cms/contacts/by-employee/:adminUserId 按员工查（contacts.read）
 *   PUT    /api/v1/cms/contacts                          创建/更新（contacts.update）
 *   PATCH  /api/v1/cms/contacts/:id/visibility           切换公开展示（contacts.update）
 *   DELETE /api/v1/cms/contacts/:id                      删除（contacts.update）
 *
 * 防幽灵员工：adminUserId 只接受系统中真实存在的员工账号。
 */
@Controller('cms/contacts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ContactsController {
  constructor(
    private readonly contactsService: ContactsService,
    private readonly rbac: RbacService,
  ) {}

  private async actorOf(request: Request & { user: AuthUser }): Promise<ActorContext> {
    const access = await this.rbac.resolveAccess(request.user.id);
    return toActorContext(request.user, access);
  }

  @Get()
  @RequirePermissions('contacts.read')
  list(@Query() query: ListContactsQueryDto): Promise<ContactListDto> {
    return this.contactsService.list(query);
  }

  @Get(':id')
  @RequirePermissions('contacts.read')
  detail(@Param('id') id: string): Promise<ContactDto> {
    return this.contactsService.findById(id);
  }

  @Get('by-employee/:adminUserId')
  @RequirePermissions('contacts.read')
  byEmployee(@Param('adminUserId') adminUserId: string): Promise<ContactDto> {
    return this.contactsService.findByAdminUser(adminUserId);
  }

  /** 创建 / 更新（每个员工一条，按 adminUserId 幂等） */
  @Put()
  @RequirePermissions('contacts.update')
  upsert(
    @Body() dto: UpsertContactDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<ContactDto> {
    return this.actorOf(request).then((actor) => this.contactsService.upsert(dto, actor));
  }

  /** 切换公开展示：独立操作，与编辑联系方式解耦 */
  @Patch(':id/visibility')
  @RequirePermissions('contacts.update')
  setVisibility(
    @Param('id') id: string,
    @Body() dto: SetShowOnSiteDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<ContactDto> {
    return this.actorOf(request).then((actor) =>
      this.contactsService.setShowOnSite(id, Boolean(dto.showOnSite), actor),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('contacts.update')
  remove(
    @Param('id') id: string,
    @Req() request: Request & { user: AuthUser },
  ): Promise<{ id: string }> {
    return this.actorOf(request).then((actor) => this.contactsService.remove(id, actor));
  }
}
