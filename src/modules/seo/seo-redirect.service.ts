import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidationService } from '../revalidation/revalidation.service';
import { CmsTags } from '../revalidation/cms-tags';
import {
  CreateSeoRedirectDto,
  ListSeoRedirectsQueryDto,
  UpdateSeoRedirectDto,
} from './dto/seo.dto';
import { PaginatedSeoRedirects, SeoRedirectDto } from './entities/seo.entity';

/** 站内路径归一化：去首尾空白、压缩重复斜杠、去结尾斜杠（根路径保留 /） */
function normalizePath(path: string): string {
  const trimmed = path.trim();
  const collapsed = trimmed.replace(/\/{2,}/g, '/');
  if (collapsed === '/' || collapsed === '') return '/';
  return collapsed.replace(/\/+$/, '');
}

/** 源路径校验：只允许站内相对路径；拒绝外部 URL / 协议相对 / 危险协议 */
function assertSourcePath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith('/')) {
    throw new BadRequestException('sourcePath 必须是站内相对路径（以 / 开头）');
  }
  if (normalized.includes('?')) {
    throw new BadRequestException('sourcePath 不允许带查询串');
  }
  return normalized;
}

/** 目标校验：站内相对路径或 https 绝对地址；拒绝危险协议 */
function assertTargetPath(path: string): string {
  const trimmed = path.trim();
  if (/^https:\/\//i.test(trimmed)) {
    try {
      new URL(trimmed);
      return trimmed;
    } catch {
      throw new BadRequestException('targetPath 不是合法 URL');
    }
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return normalizePath(trimmed);
  }
  throw new BadRequestException(
    'targetPath 必须是站内相对路径（/xxx）或 https 绝对地址；禁止 javascript:/data:/http:',
  );
}

function toDto(row: {
  id: string;
  sourcePath: string;
  targetPath: string;
  statusCode: number;
  isActive: boolean;
  note: string | null;
  hits: number;
  createdAt: Date;
  updatedAt: Date;
}): SeoRedirectDto {
  return {
    id: row.id,
    sourcePath: row.sourcePath,
    targetPath: row.targetPath,
    statusCode: row.statusCode,
    isActive: row.isActive,
    note: row.note,
    hits: row.hits,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 重定向管理（任务书二十八节）
 *
 * 安全约束（后端强制，任务书「Redirect 安全」）：
 *   · 禁止无限 redirect loop：新建 / 更新时沿既有生效规则做链式探测；
 *   · 禁止 self redirect（source 与 target 归一化后相同）；
 *   · 禁止 duplicate source（唯一索引 + 友好错误）。
 */
@Injectable()
export class SeoRedirectService {
  /** 链式探测最大跳数（防环） */
  private static readonly MAX_CHAIN = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  async list(query: ListSeoRedirectsQueryDto): Promise<PaginatedSeoRedirects> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const keyword = (query.keyword ?? '').trim();

    const where: Prisma.SeoRedirectWhereInput = {};
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (keyword) {
      where.OR = [
        { sourcePath: { contains: keyword, mode: 'insensitive' } },
        { targetPath: { contains: keyword, mode: 'insensitive' } },
        { note: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.seoRedirect.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.seoRedirect.count({ where }),
    ]);

    return {
      items: rows.map(toDto),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** 生效中的全部规则（前台 middleware 消费；不含 hits 递增） */
  async listActive(): Promise<SeoRedirectDto[]> {
    const rows = await this.prisma.seoRedirect.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  async create(dto: CreateSeoRedirectDto, actorId: string): Promise<SeoRedirectDto> {
    const source = assertSourcePath(dto.sourcePath);
    const target = assertTargetPath(dto.targetPath);

    if (source === normalizePath(target) && !/^https:\/\//i.test(target.trim())) {
      throw new BadRequestException('不允许自指向重定向（source 与 target 相同）');
    }

    // 环检测：target 若是某条生效规则的 source，沿链探测不得回到 source
    await this.assertNoLoop(source, target);

    const existing = await this.prisma.seoRedirect.findUnique({ where: { sourcePath: source } });
    if (existing) {
      throw new ConflictException(`源路径已存在重定向规则：${source}`);
    }

    const row = await this.prisma.seoRedirect.create({
      data: {
        sourcePath: source,
        targetPath: target,
        statusCode: dto.statusCode ?? 301,
        isActive: dto.isActive ?? true,
        note: dto.note ?? null,
        createdById: actorId,
      },
    });
    await this.revalidation.invalidate({ tags: [CmsTags.seo] });
    return toDto(row);
  }

  async update(id: string, dto: UpdateSeoRedirectDto): Promise<SeoRedirectDto> {
    const current = await this.prisma.seoRedirect.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('重定向规则不存在');

    const source = current.sourcePath;
    const target = dto.targetPath !== undefined ? assertTargetPath(dto.targetPath) : current.targetPath;

    if (source === normalizePath(target) && !/^https:\/\//i.test(target.trim())) {
      throw new BadRequestException('不允许自指向重定向（source 与 target 相同）');
    }
    await this.assertNoLoop(source, target);

    const row = await this.prisma.seoRedirect.update({
      where: { id },
      data: {
        targetPath: target,
        ...(dto.statusCode !== undefined ? { statusCode: dto.statusCode } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
      },
    });
    await this.revalidation.invalidate({ tags: [CmsTags.seo] });
    return toDto(row);
  }

  async remove(id: string): Promise<{ id: string }> {
    const current = await this.prisma.seoRedirect.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('重定向规则不存在');
    await this.prisma.seoRedirect.delete({ where: { id } });
    await this.revalidation.invalidate({ tags: [CmsTags.seo] });
    return { id };
  }

  /**
   * 沿既有生效规则探测 target 链条：
   * 若 target（站内部分）与某条生效规则 source 相同，则继续跳转；
   * 链条重新回到本次 source、或超过 MAX_CHAIN、或形成环 → 拒绝。
   */
  private async assertNoLoop(source: string, target: string): Promise<void> {
    const targetIsExternal = /^https:\/\//i.test(target.trim());
    if (targetIsExternal) return;

    const targetNormalized = normalizePath(target);
    const seen = new Set<string>([source]);
    let cursor = targetNormalized;

    for (let hop = 0; hop < SeoRedirectService.MAX_CHAIN; hop += 1) {
      if (seen.has(cursor)) {
        throw new BadRequestException('该重定向会形成 redirect loop，已拒绝');
      }
      seen.add(cursor);
      const next = await this.prisma.seoRedirect.findFirst({
        where: { sourcePath: cursor, isActive: true },
      });
      if (!next) return;
      if (/^https:\/\//i.test(next.targetPath)) return;
      cursor = normalizePath(next.targetPath);
      if (cursor === source) {
        throw new BadRequestException('该重定向会形成 redirect loop，已拒绝');
      }
    }
    throw new BadRequestException('重定向链条过长（可能成环），已拒绝');
  }
}
