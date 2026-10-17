import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { RbacService } from '../../rbac/rbac.service';
import { toActorContext, type ActorContext } from '../../rbac/actor-context';
import type { AuthUser } from '../../auth/auth.types';
import { SiteSectionsService } from './site-sections.service';
import { NavItemsService } from './nav-items.service';
import {
  CreateSiteSectionDto,
  ListSiteSectionsQueryDto,
  UpdateSiteSectionDto,
} from './dto/site-section.dto';
import { CreateNavItemDto, ListNavItemsQueryDto, UpdateNavItemDto } from './dto/nav-item.dto';
import type { NavItemDto, NavItemListDto, SiteSectionDto, SiteSectionListDto } from './entities/site.entity';
import { draftVersionFrom } from '../publishing/publishing.engine';

/**
 * 站点结构化内容 CMS API（Phase 4.7）。
 *
 *   GET    /api/v1/cms/site/sections           分区列表（site.read）
 *   POST   /api/v1/cms/site/sections           新建分区（site.create）
 *   GET    /api/v1/cms/site/sections/:id       分区详情（site.read）
 *   PATCH  /api/v1/cms/site/sections/:id       更新分区（site.update）
 *   DELETE /api/v1/cms/site/sections/:id       删除分区（site.delete）
 *   GET    /api/v1/cms/nav/items               导航列表（nav.read）
 *   POST   /api/v1/cms/nav/items               新建导航（nav.create）
 *   PATCH  /api/v1/cms/nav/items/:id           更新导航（nav.update）
 *   DELETE /api/v1/cms/nav/items/:id           删除导航（nav.delete）
 */
@Controller('cms')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SiteController {
  constructor(
    private readonly sections: SiteSectionsService,
    private readonly navItems: NavItemsService,
    private readonly rbac: RbacService,
  ) {}

  private async actorOf(request: Request & { user: AuthUser }): Promise<ActorContext> {
    const access = await this.rbac.resolveAccess(request.user.id);
    return toActorContext(request.user, access);
  }

  /* ------------------------------ 站点分区 ------------------------------ */

  @Get('site/sections')
  @RequirePermissions('site.read')
  listSections(@Query() query: ListSiteSectionsQueryDto): Promise<SiteSectionListDto> {
    return this.sections.list(query);
  }

  @Post('site/sections')
  @RequirePermissions('site.create')
  createSection(
    @Body() dto: CreateSiteSectionDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<SiteSectionDto> {
    return this.actorOf(request).then((actor) => this.sections.create(dto, actor));
  }

  @Get('site/sections/:id')
  @RequirePermissions('site.read')
  getSection(@Param('id') id: string): Promise<SiteSectionDto> {
    return this.sections.findById(id);
  }

  @Patch('site/sections/:id')
  @RequirePermissions('site.update')
  async updateSection(
    @Param('id') id: string,
    @Body() dto: UpdateSiteSectionDto,
    @Req() request: Request & { user: AuthUser },
  ) {
    // Phase 1：已发布过的分区，普通保存只写编辑稿，绝不覆盖线上版本
    const state = await this.sections.publishState(id);
    if (state.publishedVersion > 0 || state.hasDraft) {
      const actor = await this.actorOf(request);
      const draft = await this.sections.saveDraft(
        id,
        dto,
        actor.id,
        draftVersionFrom(request.headers),
      );
      const current = await this.sections.findById(id);
      return { ...current, hasUnpublishedChanges: true, draftVersion: draft.draftVersion };
    }
    const actor = await this.actorOf(request);
    return this.sections.update(id, dto, actor);
  }

  /** 发布当前编辑稿（独立权限 + 服务端完整性校验） */
  @Post('site/sections/:id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('site.publish')
  async publishSection(
    @Param('id') id: string,
    @Req() request: Request & { user: AuthUser },
  ): Promise<SiteSectionDto> {
    const actor = await this.actorOf(request);
    return this.sections.publish(id, actor);
  }

  /** 取消发布（保留内容与历史） */
  @Post('site/sections/:id/unpublish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('site.unpublish')
  async unpublishSection(
    @Param('id') id: string,
    @Req() request: Request & { user: AuthUser },
  ): Promise<SiteSectionDto> {
    const actor = await this.actorOf(request);
    return this.sections.unpublish(id, actor);
  }

  /** 预览（线上版本 + 编辑稿，仅后台授权访问） */
  @Get('site/sections/:id/preview')
  @RequirePermissions('site.read')
  previewSection(@Param('id') id: string) {
    return this.sections.preview(id);
  }

  /** 发布历史 */
  @Get('site/sections/:id/revisions')
  @RequirePermissions('site.read')
  sectionRevisions(@Param('id') id: string) {
    return this.sections.revisions(id);
  }

  @Delete('site/sections/:id')
  @RequirePermissions('site.delete')
  removeSection(
    @Param('id') id: string,
    @Req() request: Request & { user: AuthUser },
  ): Promise<{ id: string }> {
    return this.actorOf(request).then((actor) => this.sections.remove(id, actor));
  }

  /* ------------------------------ 导航项 ------------------------------ */

  @Get('nav/items')
  @RequirePermissions('nav.read')
  listNavItems(@Query() query: ListNavItemsQueryDto): Promise<NavItemListDto> {
    return this.navItems.list(query);
  }

  @Post('nav/items')
  @RequirePermissions('nav.create')
  createNavItem(
    @Body() dto: CreateNavItemDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<NavItemDto> {
    return this.actorOf(request).then((actor) => this.navItems.create(dto, actor));
  }

  @Patch('nav/items/:id')
  @RequirePermissions('nav.update')
  updateNavItem(
    @Param('id') id: string,
    @Body() dto: UpdateNavItemDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<NavItemDto> {
    return this.actorOf(request).then((actor) => this.navItems.update(id, dto, actor));
  }

  @Delete('nav/items/:id')
  @RequirePermissions('nav.delete')
  removeNavItem(
    @Param('id') id: string,
    @Req() request: Request & { user: AuthUser },
  ): Promise<{ id: string }> {
    return this.actorOf(request).then((actor) => this.navItems.remove(id, actor));
  }
}
