import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApplicationProductItemDto,
  CreateApplicationDto,
  UpdateApplicationDto,
} from './dto/application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import {
  toApplicationDetail,
  toApplicationListItem,
  type ApplicationDetailDto,
  type ApplicationWithRelations,
  type PaginatedApplicationsDto,
} from './entities/application.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

const APPLICATION_INCLUDE = {
  coverMedia: true,
  products: { include: { product: true } },
  _count: { select: { products: true } },
} satisfies Prisma.ApplicationInclude;

/**
 * 产品应用场景 CMS 服务（Phase 4.5）。
 *
 * 关联完整性要点：
 *   · 产品关联用显式多对多表 application_products，**不用产品名字符串匹配**
 *   · productId 先做批量存在性校验，非法引用返回 400 而非外键异常
 *   · 关联集合整体替换：删除未出现的、更新携带的、新建新增的（保留 sortOrder）
 *   · 删除应用场景只级联删除关联行（application_products），
 *     **绝不删除 Product 本身**（Product 侧 onDelete: Restrict 亦有一层保护）
 */
@Injectable()
export class ApplicationsService {
  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------ 查询 ------------------------------ */

  /** 应用场景列表：分页 + keyword / status / featured 筛选 */
  async list(query: ListApplicationsQueryDto): Promise<PaginatedApplicationsDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const where: Prisma.ApplicationWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.featured !== undefined) where.featured = query.featured;
    if (query.keyword) {
      where.OR = [
        { name: { contains: query.keyword, mode: 'insensitive' } },
        { slug: { contains: query.keyword, mode: 'insensitive' } },
        { summary: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.application.count({ where }),
      this.prisma.application.findMany({
        where,
        include: APPLICATION_INCLUDE,
        orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: (rows as ApplicationWithRelations[]).map(toApplicationListItem),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 详情 */
  async findById(id: string): Promise<ApplicationDetailDto> {
    const row = await this.prisma.application.findUnique({
      where: { id },
      include: APPLICATION_INCLUDE,
    });
    if (!row) throw new NotFoundException('Application not found.');
    return toApplicationDetail(row as ApplicationWithRelations);
  }

  /* ------------------------------ 创建 ------------------------------ */

  async create(dto: CreateApplicationDto): Promise<ApplicationDetailDto> {
    await this.assertSlugAvailable(dto.slug);

    const status = dto.status ?? ContentStatus.DRAFT;
    const coverMediaId = dto.coverMediaId ?? null;
    if (coverMediaId) await this.assertMediaExists(coverMediaId);

    const productItems = dto.products ?? [];
    await this.assertProductsExist(productItems.map((item) => item.productId));

    const coverUrl = coverMediaId ? await this.resolveMediaUrl(coverMediaId) : null;

    const created = await this.prisma.$transaction(async (tx) => {
      const application = await tx.application.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          summary: dto.summary ?? null,
          description: dto.description ?? null,
          coverMediaId,
          coverImageUrl: coverUrl,
          status,
          featured: dto.featured ?? false,
          sortOrder: dto.sortOrder ?? 0,
          publishedAt: this.resolvePublishedAt(status, dto.publishedAt ?? null),
          seoTitle: dto.seoTitle ?? null,
          seoDescription: dto.seoDescription ?? null,
        },
      });

      if (productItems.length > 0) {
        await tx.applicationProduct.createMany({
          data: this.dedupeProducts(productItems).map((item, index) => ({
            applicationId: application.id,
            productId: item.productId,
            sortOrder: item.sortOrder ?? index,
          })),
        });
      }

      return tx.application.findUniqueOrThrow({
        where: { id: application.id },
        include: APPLICATION_INCLUDE,
      });
    });

    return toApplicationDetail(created as ApplicationWithRelations);
  }

  /* ------------------------------ 更新 ------------------------------ */

  async update(id: string, dto: UpdateApplicationDto): Promise<ApplicationDetailDto> {
    const existing = await this.prisma.application.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Application not found.');

    if (dto.slug && dto.slug !== existing.slug) {
      await this.assertSlugAvailable(dto.slug);
    }

    // coverMediaId：undefined = 不改动；null = 清空；字符串 = 换封面
    let coverMediaId = existing.coverMediaId;
    let coverImageUrl = existing.coverImageUrl;
    if (dto.coverMediaId !== undefined) {
      if (dto.coverMediaId === null) {
        coverMediaId = null;
        coverImageUrl = null;
      } else {
        await this.assertMediaExists(dto.coverMediaId);
        coverMediaId = dto.coverMediaId;
        coverImageUrl = await this.resolveMediaUrl(dto.coverMediaId);
      }
    }

    const status = dto.status ?? existing.status;

    if (dto.products !== undefined) {
      await this.assertProductsExist(dto.products.map((item) => item.productId));
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.featured !== undefined ? { featured: dto.featured } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.seoTitle !== undefined ? { seoTitle: dto.seoTitle } : {}),
          ...(dto.seoDescription !== undefined ? { seoDescription: dto.seoDescription } : {}),
          coverMediaId,
          coverImageUrl,
          status,
          publishedAt: this.resolvePublishedAt(status, dto.publishedAt, existing.publishedAt),
        },
      });

      if (dto.products !== undefined) {
        await this.syncProducts(tx, id, dto.products);
      }
    });

    return this.findById(id);
  }

  /* ------------------------------ 删除 ------------------------------ */

  /**
   * 删除应用场景。
   *
   * 级联删除 application_products 关联行；**不删除任何 Product**。
   */
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.prisma.application.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Application not found.');

    await this.prisma.application.delete({ where: { id } });
    return { id };
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  /**
   * 关联产品集合同步：整体替换语义。
   *   · 不在新集合中的旧关联 → 删除
   *   · 新集合中的关联 → upsert（保留/更新 sortOrder）
   * 全部基于 (applicationId, productId) 复合主键，保证幂等。
   */
  private async syncProducts(
    tx: Prisma.TransactionClient,
    applicationId: string,
    items: ApplicationProductItemDto[],
  ): Promise<void> {
    const deduped = this.dedupeProducts(items);
    const keepIds = deduped.map((item) => item.productId);

    await tx.applicationProduct.deleteMany({
      where: {
        applicationId,
        ...(keepIds.length > 0 ? { productId: { notIn: keepIds } } : {}),
      },
    });

    for (const [index, item] of deduped.entries()) {
      await tx.applicationProduct.upsert({
        where: {
          applicationId_productId: { applicationId, productId: item.productId },
        },
        create: {
          applicationId,
          productId: item.productId,
          sortOrder: item.sortOrder ?? index,
        },
        update: { sortOrder: item.sortOrder ?? index },
      });
    }
  }

  /** 去重：同一 productId 只保留首次出现（避免复合主键冲突） */
  private dedupeProducts(items: ApplicationProductItemDto[]): ApplicationProductItemDto[] {
    const seen = new Set<string>();
    const result: ApplicationProductItemDto[] = [];
    for (const item of items) {
      if (seen.has(item.productId)) continue;
      seen.add(item.productId);
      result.push(item);
    }
    return result;
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    const taken = await this.prisma.application.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (taken) throw new ConflictException(`slug 已被占用：${slug}`);
  }

  private async assertMediaExists(mediaId: string): Promise<void> {
    const found = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { id: true },
    });
    if (!found) throw new BadRequestException(`媒体资源不存在：${mediaId}`);
  }

  /** 批量产品存在性校验：去重后比对数量，报告缺失 id */
  private async assertProductsExist(productIds: string[]): Promise<void> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) return;
    const found = await this.prisma.product.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      const foundSet = new Set(found.map((row) => row.id));
      const missing = unique.filter((id) => !foundSet.has(id));
      throw new BadRequestException(`产品不存在：${missing.join(', ')}`);
    }
  }

  private async resolveMediaUrl(mediaId: string): Promise<string> {
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { url: true },
    });
    if (!media) throw new BadRequestException(`媒体资源不存在：${mediaId}`);
    return media.url;
  }

  private resolvePublishedAt(
    status: ContentStatus,
    incoming: string | Date | null | undefined,
    existing: Date | null = null,
  ): Date | null {
    if (incoming) return new Date(incoming);
    if (status === ContentStatus.PUBLISHED) return existing ?? new Date();
    return existing;
  }
}
