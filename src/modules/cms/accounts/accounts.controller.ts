import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { RbacService } from '../../rbac/rbac.service';
import { toActorContext, type ActorContext } from '../../rbac/actor-context';
import type { AuthUser } from '../../auth/auth.types';
import { AccountsService } from './accounts.service';
import {
  CreateAccountDto,
  ListAccountsQueryDto,
  ResetPasswordDto,
  SetAccountStatusDto,
  UpdateAccountDto,
} from './dto/account.dto';
import type {
  AccountDetailDto,
  AssignableRoleDto,
  CreateAccountResultDto,
  PaginatedAccountsDto,
} from './entities/account.entity';

/**
 * 账号管理 CMS API（Phase 4.6）。
 *
 *   GET   /api/v1/cms/accounts                    列表（accounts.read）
 *   GET   /api/v1/cms/accounts/assignable-roles   可分配角色（accounts.read）
 *   POST  /api/v1/cms/accounts                    创建（accounts.create）
 *   GET   /api/v1/cms/accounts/:id                详情（accounts.read）
 *   PATCH /api/v1/cms/accounts/:id                更新（accounts.update）
 *   PATCH /api/v1/cms/accounts/:id/status         启用/停用（accounts.disable）
 *   POST  /api/v1/cms/accounts/:id/reset-password 重置口令（accounts.update）
 *
 * 口令相关：创建与重置是**唯一**会返回明文口令的接口，且都只返回一次。
 */
@Controller('cms/accounts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AccountsController {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly rbac: RbacService,
  ) {}

  private async actorOf(request: Request & { user: AuthUser }): Promise<ActorContext> {
    const access = await this.rbac.resolveAccess(request.user.id);
    return toActorContext(request.user, access);
  }

  @Get()
  @RequirePermissions('accounts.read')
  list(@Query() query: ListAccountsQueryDto): Promise<PaginatedAccountsDto> {
    return this.accountsService.list(query);
  }

  @Get('assignable-roles')
  @RequirePermissions('accounts.read')
  assignableRoles(@Req() request: Request & { user: AuthUser }): Promise<AssignableRoleDto[]> {
    return this.actorOf(request).then((actor) => this.accountsService.assignableRoles(actor));
  }

  @Post()
  @RequirePermissions('accounts.create')
  create(
    @Body() dto: CreateAccountDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<CreateAccountResultDto> {
    return this.actorOf(request).then((actor) => this.accountsService.create(dto, actor));
  }

  @Get(':id')
  @RequirePermissions('accounts.read')
  detail(@Param('id') id: string): Promise<AccountDetailDto> {
    return this.accountsService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('accounts.update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<AccountDetailDto> {
    return this.actorOf(request).then((actor) => this.accountsService.update(id, dto, actor));
  }

  /** 启用 / 停用：权限独立于 accounts.update，避免有编辑权即可停用账号 */
  @Patch(':id/status')
  @RequirePermissions('accounts.disable')
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetAccountStatusDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<AccountDetailDto> {
    return this.actorOf(request).then((actor) => this.accountsService.setStatus(id, dto, actor));
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('accounts.update')
  resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<{ initialPassword: string }> {
    return this.actorOf(request).then((actor) =>
      this.accountsService.resetPassword(id, dto, actor),
    );
  }
}
