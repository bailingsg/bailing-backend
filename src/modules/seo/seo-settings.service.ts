import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, SeoSettings } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidationService } from '../revalidation/revalidation.service';
import { CmsTags } from '../revalidation/cms-tags';
import { UpdateSeoSettingsDto } from './dto/seo-settings.dto';

/** 单例行 ID */
const SETTINGS_ID = 'global';

/** URL 字段安全校验：站内相对路径（/ 或 /xxx）或 https 绝对地址 */
function assertSafeUrl(value: string | null | undefined, field: string): void {
  if (value === null || value === undefined || value === '') return;
  if (/^https:\/\//i.test(value)) return;
  if (value.startsWith('/') && !value.startsWith('//')) return;
  throw new BadRequestException(`${field} 必须是站内相对路径（/xxx）或 https 绝对地址`);
}

/** canonicalDomain 校验：必须是 https（或空） */
function assertCanonicalDomain(value: string | null | undefined): void {
  if (value === null || value === undefined || value === '') return;
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(value)) {
    throw new BadRequestException('canonicalDomain 必须是 https://域名 形态（不含路径与查询串）');
  }
}

/** 标题模板校验：必须包含 %title% 占位符（空串按默认值处理） */
function assertTemplate(value: string | null | undefined, field: string): void {
  if (value === null || value === undefined || value === '') return;
  if (!value.includes('%title%')) {
    throw new BadRequestException(`${field} 必须包含 %title% 占位符`);
  }
  if (value.length > 120) {
    throw new BadRequestException(`${field} 超过 120 字符`);
  }
}

/**
 * SEO 全局设置服务（任务书十九~二十节）
 *
 * 单例表：首条读取时若无记录则按 schema 默认值创建。
 * 任何更新都触发前台 `seo` tag 失效——SEO 元数据是全站 metadata 的底座。
 */
@Injectable()
export class SeoSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  /** 读取全局设置（不存在则创建默认行） */
  async getSettings(): Promise<SeoSettings> {
    const existing = await this.prisma.seoSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (existing) return existing;
    return this.prisma.seoSettings.create({ data: { id: SETTINGS_ID } });
  }

  /** 后台全量字段（含 GA/GTM 等内部配置） */
  async getSettingsForAdmin(): Promise<SeoSettings> {
    return this.getSettings();
  }

  /** 更新全局设置（部分字段；空串 = 清空可空字段） */
  async updateSettings(dto: UpdateSeoSettingsDto, actorId: string): Promise<SeoSettings> {
    await this.getSettings(); // 确保存在

    // —— 安全校验（入口拦截，违规 400）——
    assertCanonicalDomain(dto.canonicalDomain);
    assertSafeUrl(dto.defaultOgImage, 'defaultOgImage');
    assertSafeUrl(dto.defaultTwitterImage, 'defaultTwitterImage');
    assertSafeUrl(dto.companyLogo, 'companyLogo');
    assertSafeUrl(dto.companyWebsite, 'companyWebsite');
    for (const key of ['linkedin', 'facebook', 'instagram', 'youtube', 'whatsapp'] as const) {
      const value = dto[key];
      if (value) {
        if (!/^https:\/\//i.test(value)) {
          throw new BadRequestException(`${key} 必须是 https 链接`);
        }
      }
    }
    if (dto.googleSiteVerification && !/^[A-Za-z0-9_-]{10,80}$/.test(dto.googleSiteVerification)) {
      throw new BadRequestException('googleSiteVerification 格式不正确');
    }
    if (dto.googleAnalyticsId && !/^(G|UA|GT)-[A-Za-z0-9-]{4,30}$/.test(dto.googleAnalyticsId)) {
      throw new BadRequestException('googleAnalyticsId 格式不正确（如 G-XXXXXXX）');
    }
    if (dto.googleTagManagerId && !/^GTM-[A-Za-z0-9]{4,12}$/.test(dto.googleTagManagerId)) {
      throw new BadRequestException('googleTagManagerId 格式不正确（如 GTM-XXXXXXX）');
    }
    assertTemplate(dto.pageTitleTemplate, 'pageTitleTemplate');
    assertTemplate(dto.productTitleTemplate, 'productTitleTemplate');
    assertTemplate(dto.blogTitleTemplate, 'blogTitleTemplate');
    assertTemplate(dto.categoryTitleTemplate, 'categoryTitleTemplate');

    const data: Prisma.SeoSettingsUpdateInput = {};
    const keys = [
      'siteName',
      'siteTitle',
      'siteDescription',
      'defaultOgImage',
      'defaultTwitterImage',
      'canonicalDomain',
      'pageTitleTemplate',
      'productTitleTemplate',
      'blogTitleTemplate',
      'categoryTitleTemplate',
      'companyName',
      'companyLogo',
      'companyWebsite',
      'companyEmail',
      'companyPhone',
      'companyAddress',
      'companyCountry',
      'linkedin',
      'facebook',
      'instagram',
      'youtube',
      'whatsapp',
      'googleSiteVerification',
      'googleAnalyticsId',
      'googleTagManagerId',
    ] as const;

    for (const key of keys) {
      const value = dto[key];
      if (value === undefined) continue;
      (data as Record<string, unknown>)[key] = value === '' ? null : value;
    }

    const updated = await this.prisma.seoSettings.update({
      where: { id: SETTINGS_ID },
      data: { ...data, updatedById: actorId },
    });

    // SEO 设置影响全站 metadata：通知前台失效 seo tag / sitemap / robots
    await this.revalidation.invalidate({
      tags: [CmsTags.seo],
      paths: ['/sitemap.xml', '/robots.txt'],
    });

    return updated;
  }

  /** 站点基准域名（canonical / sitemap / robots 的唯一真相；未配置返回 null） */
  async getCanonicalDomain(): Promise<string | null> {
    const settings = await this.getSettings();
    return settings.canonicalDomain;
  }
}
