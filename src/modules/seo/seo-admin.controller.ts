import {
  BadRequestException,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { SeoProfileService } from './seo-profile.service';
import { SeoSettingsService } from './seo-settings.service';
import { SeoRedirectService } from './seo-redirect.service';
import { SeoAuditService } from './seo-audit.service';
import { SeoSitemapService } from './seo-sitemap.service';
import {
  CreateSeoRedirectDto,
  ListSeoEntitiesQueryDto,
  ListSeoRedirectsQueryDto,
  QuickFixSeoDto,
  UpdateSeoProfileDto,
  UpdateSeoRedirectDto,
} from './dto/seo.dto';
import { UpdateSeoSettingsDto } from './dto/seo-settings.dto';
import { SEO_ENTITY_TYPES } from './seo.constants';

/** 已鉴权请求（JwtAuthGuard 保证 user 存在） */
interface AuthedRequest {
  user: { id: string };
}

/**
 * SEO 管理中心 API（Phase 5.0，控制器级 JwtAuthGuard + PermissionsGuard）。
 *
 *   GET    /cms/seo/overview                      Dashboard 汇总
 *   GET    /cms/seo/settings                      全局设置（后台全量）
 *   PUT    /cms/seo/settings                      更新全局设置
 *   GET    /cms/seo/pages                         静态页面 SEO 列表
 *   GET    /cms/seo/products                      产品 SEO 列表
 *   GET    /cms/seo/blog                          博客 SEO 列表
 *   GET    /cms/seo/profiles/:entityType/:entityId 档案详情（含评分明细）
 *   PUT    /cms/seo/profiles/:entityType/:entityId 创建 / 更新档案
 *   POST   /cms/seo/profiles/:entityType/:entityId/quick-fix 快捷修复（返回 diff）
 *   GET    /cms/seo/redirects                     重定向列表
 *   POST   /cms/seo/redirects                     新建重定向
 *   PATCH  /cms/seo/redirects/:id                 更新重定向
 *   DELETE /cms/seo/redirects/:id                 删除重定向
 *   GET    /cms/seo/sitemap                       sitemap 条目预览（后台）
 *   GET    /cms/seo/robots                        robots.txt 预览（后台）
 *   GET    /cms/seo/audit                         最近一次审计结果
 *   POST   /cms/seo/audit                         运行全站审计（只读检查）
 */
@Controller('cms/seo')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SeoAdminController {
  constructor(
    private readonly profileService: SeoProfileService,
    private readonly settingsService: SeoSettingsService,
    private readonly redirectService: SeoRedirectService,
    private readonly auditService: SeoAuditService,
    private readonly sitemapService: SeoSitemapService,
  ) {}

  /* ------------------------------ 总览 ------------------------------ */

  @Get('overview')
  @RequirePermissions('seo.read')
  overview() {
    return this.profileService.getOverview();
  }

  /* ------------------------------ 全局设置 ------------------------------ */

  @Get('settings')
  @RequirePermissions('seo.read')
  getSettings() {
    return this.settingsService.getSettingsForAdmin();
  }

  @Put('settings')
  @RequirePermissions('seo.settings')
  updateSettings(@Body() dto: UpdateSeoSettingsDto, @Req() request: AuthedRequest) {
    return this.settingsService.updateSettings(dto, request.user.id);
  }

  /* ------------------------------ 实体列表 ------------------------------ */

  @Get('pages')
  @RequirePermissions('seo.read')
  listPages(@Query() query: ListSeoEntitiesQueryDto) {
    return this.profileService.listEntities('PAGE', query);
  }

  @Get('products')
  @RequirePermissions('seo.read')
  listProducts(@Query() query: ListSeoEntitiesQueryDto) {
    return this.profileService.listEntities('PRODUCT', query);
  }

  @Get('blog')
  @RequirePermissions('seo.read')
  listBlog(@Query() query: ListSeoEntitiesQueryDto) {
    return this.profileService.listEntities('BLOG_POST', query);
  }

  /* ------------------------------ 档案读写 ------------------------------ */

  @Get('profiles/:entityType/:entityId')
  @RequirePermissions('seo.read')
  getProfile(@Param('entityType') entityType: string, @Param('entityId') entityId: string) {
    this.assertEntityType(entityType);
    return this.profileService.getProfile(entityType, entityId);
  }

  @Put('profiles/:entityType/:entityId')
  @RequirePermissions('seo.manage')
  updateProfile(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Body() dto: UpdateSeoProfileDto,
    @Req() request: AuthedRequest,
  ) {
    this.assertEntityType(entityType);
    return this.profileService.upsertProfile(entityType, entityId, dto, request.user.id);
  }

  @Post('profiles/:entityType/:entityId/quick-fix')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('seo.manage')
  quickFix(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Body() dto: QuickFixSeoDto,
    @Req() request: AuthedRequest,
  ) {
    this.assertEntityType(entityType);
    return this.profileService.quickFix(entityType, entityId, dto.fields ?? [], request.user.id, dto.dryRun === true);
  }

  /* ------------------------------ 重定向 ------------------------------ */

  @Get('redirects')
  @RequirePermissions('seo.read')
  listRedirects(@Query() query: ListSeoRedirectsQueryDto) {
    return this.redirectService.list(query);
  }

  @Post('redirects')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('seo.redirect')
  createRedirect(@Body() dto: CreateSeoRedirectDto, @Req() request: AuthedRequest) {
    return this.redirectService.create(dto, request.user.id);
  }

  @Patch('redirects/:id')
  @RequirePermissions('seo.redirect')
  updateRedirect(@Param('id') id: string, @Body() dto: UpdateSeoRedirectDto) {
    return this.redirectService.update(id, dto);
  }

  @Delete('redirects/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('seo.redirect')
  removeRedirect(@Param('id') id: string) {
    return this.redirectService.remove(id);
  }

  /* ------------------------------ Sitemap / Robots 预览 ------------------------------ */

  @Get('sitemap')
  @RequirePermissions('seo.read')
  sitemapPreview() {
    return this.sitemapService.getEntries();
  }

  @Get('robots')
  @RequirePermissions('seo.read')
  async robotsPreview() {
    const text = await this.sitemapService.getRobotsText('https://bailingwooden.com');
    return { robots: text };
  }

  /* ------------------------------ 审计 ------------------------------ */

  @Get('audit')
  @RequirePermissions('seo.read')
  getAudit() {
    return this.auditService.getLatest();
  }

  @Post('audit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('seo.audit')
  runAudit(@Req() request: AuthedRequest) {
    return this.auditService.runAudit(request.user.id);
  }

  private assertEntityType(value: string): void {
    if (!(SEO_ENTITY_TYPES as readonly string[]).includes(value)) {
      throw new BadRequestException(`不支持的 SEO 实体类型：${value}`);
    }
  }
}
