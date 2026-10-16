import { Controller, Get, Query } from '@nestjs/common';
import { SeoProfileService } from './seo-profile.service';
import { SeoSettingsService } from './seo-settings.service';
import { SeoRedirectService } from './seo-redirect.service';
import { SeoSitemapService } from './seo-sitemap.service';
import { PublicSeoResolveQueryDto } from './dto/seo-public.dto';

/**
 * SEO 公开 API（只读，无需登录）。
 *
 *   GET /public/seo/settings    公开安全的全局设置（站点名 / 标题模板 / 默认 OG 图 / 验证 meta）
 *   GET /public/seo/resolve     按路径批量解析生效 SEO 元数据（?paths=/products/a,/blog/b）
 *   GET /public/seo/sitemap     sitemap 条目（前台 sitemap.xml 数据源）
 *   GET /public/seo/redirects   生效中的重定向规则（前台 middleware 数据源）
 *
 * 安全：响应一律走白名单投影，绝不出透内部字段（updatedById / createdBy / GA 配置的
 * 内部备注等）；未配置项为 null，前台据此走默认逻辑，不输出空标签。
 */
@Controller('public/seo')
export class SeoPublicController {
  constructor(
    private readonly profileService: SeoProfileService,
    private readonly settingsService: SeoSettingsService,
    private readonly redirectService: SeoRedirectService,
    private readonly sitemapService: SeoSitemapService,
  ) {}

  @Get('settings')
  async settings() {
    return this.publicSettings();
  }

  /** 公开安全投影的全局设置（不含 GA/GTM 等内部配置的敏感语义字段） */
  private async publicSettings() {
    const s = await this.settingsService.getSettings();
    return {
      siteName: s.siteName,
      siteTitle: s.siteTitle,
      siteDescription: s.siteDescription,
      defaultOgImage: s.defaultOgImage,
      defaultTwitterImage: s.defaultTwitterImage,
      canonicalDomain: s.canonicalDomain,
      pageTitleTemplate: s.pageTitleTemplate,
      productTitleTemplate: s.productTitleTemplate,
      blogTitleTemplate: s.blogTitleTemplate,
      categoryTitleTemplate: s.categoryTitleTemplate,
      companyName: s.companyName,
      companyLogo: s.companyLogo,
      companyWebsite: s.companyWebsite,
      companyEmail: s.companyEmail,
      companyPhone: s.companyPhone,
      companyAddress: s.companyAddress,
      companyCountry: s.companyCountry,
      linkedin: s.linkedin,
      facebook: s.facebook,
      instagram: s.instagram,
      youtube: s.youtube,
      whatsapp: s.whatsapp,
      googleSiteVerification: s.googleSiteVerification,
    };
  }

  @Get('resolve')
  async resolve(@Query() query: PublicSeoResolveQueryDto) {
    const paths = (query.paths ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    // 一次往返同时返回全局设置与档案（前台 metadata 解析的数据底座）
    return { settings: await this.publicSettings(), profiles: await this.profileService.resolveByPaths(paths) };
  }

  @Get('sitemap')
  async sitemap() {
    return { entries: await this.sitemapService.getEntries() };
  }

  @Get('redirects')
  async redirects() {
    return { redirects: await this.redirectService.listActive() };
  }
}
