import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import { RolesService } from './roles.service';
import {
  AssignPermissionsDto,
  CreateRoleDto,
  ListRolesQueryDto,
  UpdateRoleDto,
} from './dto/role.dto';
import type {
  CreateRoleResultDto,
  PaginatedRolesDto,
  PermissionMatrixDto,
  RoleDetailDto,
} from './entities/role.entity';

/**
 * 角色与权限管理 CMS API（Phase 4.6）。
 *
 *   GET    /api/v1/cms/roles                       角色列表（roles.read）
 *   GET    /api/v1/cms/roles/permission-matrix     权限矩阵（roles.read）
 *   POST   /api/v1/cms/roles                       创建角色（roles.create）
 *   GET    /api/v1/cms/roles/:id                   角色详情（roles.read）
 *   PATCH  /api/v1/cms/roles/:id                   更新角色（roles.update）
 *   PUT    /api/v1/cms/roles/:id/permissions       分配权限（roles.assign_permissions）
 *   DELETE /api/v1/cms/roles/:id                   删除角色（roles.update）
 *
 * Guard 顺序很重要：JwtAuthGuard 先验签 → PermissionsGuard 再查库校验权限与账号状态。
 */
@Controller('cms/roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(
    private readonly rolesService: RolesService,
    private readonly rbac: RbacService,
  ) {}

  /** 从 request.user 构造带实时权限的操作人上下文（供审计与提权校验） */
  private async actorOf(request: Request & { user: AuthUser }): Promise<ActorContext> {
    const access = await this.rbac.resolveAccess(request.user.id);
    return toActorContext(request.user, access);
  }

  @Get()
  @RequirePermissions('roles.read')
  list(@Query() query: ListRolesQueryDto): Promise<PaginatedRolesDto> {
    return this.rolesService.list(query);
  }

  /** 权限矩阵：前端分组复选框的数据源（与后端校验同源，来自代码注册表） */
  @Get('permission-matrix')
  @RequirePermissions('roles.read')
  permissionMatrix(): PermissionMatrixDto {
    return this.rolesService.permissionMatrix();
  }

  @Post()
  @RequirePermissions('roles.create')
  create(
    @Body() dto: CreateRoleDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<CreateRoleResultDto> {
    return this.actorOf(request).then((actor) => this.rolesService.create(dto, actor));
  }

  @Get(':id')
  @RequirePermissions('roles.read')
  detail(@Param('id') id: string): Promise<RoleDetailDto> {
    return this.rolesService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('roles.update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<RoleDetailDto> {
    return this.actorOf(request).then((actor) => this.rolesService.update(id, dto, actor));
  }

  /** 分配权限：权限范围独立于 roles.update，防止有编辑权的人顺手给自己提权 */
  @Put(':id/permissions')
  @RequirePermissions('roles.assign_permissions')
  assignPermissions(
    @Param('id') id: string,
    @Body() dto: AssignPermissionsDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<RoleDetailDto> {
    return this.actorOf(request).then((actor) =>
      this.rolesService.assignPermissions(id, dto, actor),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('roles.update')
  remove(
    @Param('id') id: string,
    @Req() request: Request & { user: AuthUser },
  ): Promise<{ id: string }> {
    return this.actorOf(request).then((actor) => this.rolesService.remove(id, actor));
  }
}
