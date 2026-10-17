import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContentEntityType } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  appendRevision,
  clearDraft,
  listRevisions,
  readDraft,
  saveDraftPayload,
  type DraftRecord,
} from './publishing.store';

/**
 * 发布工作流引擎（Phase 1）。
 *
 * 六类内容实体（Product / BlogPost / FactorySection / QualityRecord /
 * Application / SiteSection）共用同一套状态机与并发语义，差异点收敛到
 * PublishAdapter：
 *
 *   · 字段映射（草稿 payload → 实体行）——各模块 DTO 不同
 *   · 发布完整性校验——各实体必填集不同
 *   · 快照形状——各实体公开 DTO 不同
 *   · 缓存失效——各实体 tag / path 不同
 *
 * 状态机：
 *
 *   DRAFT ──publish──> PUBLISHED ──unpublish──> UNPUBLISHED
 *     │                    │                        │
 *     └────────────────────┴──────publish───────────┘
 *
 * 不变量（不可违反）：
 *   1. 实体行**永远保存线上版本**；未发布过的实体行即初始草稿。
 *   2. 已发布实体（publishedVersion > 0）的普通保存只写 ContentDraft，
 *      绝不修改实体行 —— 这是「保存 ≠ 发布」的技术保证。
 *   3. 发布是原子的：应用草稿 + 状态切换 + 版本推进 + 快照落库在**同一事务**，
 *      任一步失败整体回滚，线上版本保持原样。
 *   4. 版本号单调递增且唯一（ContentRevision 唯一约束兜底并发）。
 */

/** 实体行的最小公共视图 */
export interface PublishableRow {
  id: string;
  status: string;
  version: number;
  publishedVersion: number;
}

/**
 * 各实体接入发布工作流需要提供的适配器。
 * 泛型 TRow 为该实体 Service 实际查询出的行类型（含关联）。
 */
export interface PublishAdapter<TRow extends PublishableRow> {
  entityType: ContentEntityType;
  /** 中文实体名（错误信息用），如「产品」 */
  label: string;
  /** 读取实体行（不含事务；不存在返回 null） */
  findRow(id: string): Promise<TRow | null>;
  /**
   * 应用编辑稿（事务内）。
   * payload 为 null 时表示「无编辑稿，直接发布当前行内容」，此时只需返回当前行。
   */
  applyDraft(
    id: string,
    payload: Record<string, unknown> | null,
    tx: Prisma.TransactionClient,
  ): Promise<TRow>;
  /** 标记发布并推进 publishedVersion（事务内，返回更新后的行） */
  markPublished(id: string, nextVersion: number, tx: Prisma.TransactionClient): Promise<TRow>;
  /** 标记取消发布（事务内，返回更新后的行） */
  markUnpublished(id: string, tx: Prisma.TransactionClient): Promise<TRow>;
  /** 发布前完整性校验：不满足抛 BadRequestException（消息面向操作人） */
  validate(row: TRow): void;
  /** 生成版本快照（与公开 API 输出同构） */
  toSnapshot(row: TRow): unknown;
}

export interface PublishState {
  status: string;
  version: number;
  publishedVersion: number;
  hasDraft: boolean;
  draftVersion: number | null;
  /** 存在未发布修改（编辑稿） */
  hasUnpublishedChanges: boolean;
}

/**
 * 发布动作的结果元信息。
 * publish / unpublish 的 HTTP 响应 = 实体详情 DTO + 这份元信息，
 * 后台据此展示「线上版本号」「是否存在未发布修改」，无需再发一次 preview 请求。
 */
export interface PublishResult<TRow> {
  row: TRow;
  /** 操作后的线上版本号（publishedVersion；0 = 从未发布过） */
  publishedVersion: number;
  /** 是否仍存在未发布修改（发布成功编辑稿被清空 → false） */
  hasUnpublishedChanges: boolean;
  /** 编辑稿版本号（无编辑稿为 null），前端下次保存时作为 X-Draft-Version 回传 */
  draftVersion: number | null;
}

/** 把发布元信息附加到实体详情 DTO 上（不修改原 DTO 定义） */
export function withPublishMeta<TDto extends object, TRow>(
  dto: TDto,
  result: PublishResult<TRow>,
): TDto & Omit<PublishResult<TRow>, 'row'> {
  return {
    ...dto,
    publishedVersion: result.publishedVersion,
    hasUnpublishedChanges: result.hasUnpublishedChanges,
    draftVersion: result.draftVersion,
  };
}

/** 发布状态快照（控制器据此决定「直接改行」还是「写编辑稿」） */
export async function getPublishState<TRow extends PublishableRow>(
  prisma: PrismaService,
  adapter: PublishAdapter<TRow>,
  id: string,
): Promise<PublishState> {
  const row = await adapter.findRow(id);
  if (!row) throw new NotFoundException(`${adapter.label}不存在`);

  const draft = await readDraft(prisma, adapter.entityType, id);
  return {
    status: row.status,
    version: row.version,
    publishedVersion: row.publishedVersion,
    hasDraft: draft !== null,
    draftVersion: draft?.version ?? null,
    hasUnpublishedChanges: draft !== null,
  };
}

/**
 * 保存编辑稿。
 * 仅当实体已发布过（publishedVersion > 0）或已存在编辑稿时才有意义；
 * 从未发布的实体由调用方直接更新实体行（行内即草稿）。
 */
export async function saveEntityDraft<TRow extends PublishableRow>(
  prisma: PrismaService,
  adapter: PublishAdapter<TRow>,
  id: string,
  payload: Record<string, unknown>,
  actorId: string | null,
  expectedVersion?: number,
): Promise<{ draftVersion: number; updatedAt: Date; baseVersion: number }> {
  const row = await adapter.findRow(id);
  if (!row) throw new NotFoundException(`${adapter.label}不存在`);

  const draft = await saveDraftPayload(
    prisma,
    adapter.entityType,
    id,
    payload,
    actorId,
    expectedVersion,
    row.publishedVersion,
  );
  return { draftVersion: draft.version, updatedAt: draft.updatedAt, baseVersion: draft.baseVersion };
}

/**
 * 发布：把编辑稿（若有）应用为线上版本。
 *
 * 并发保护：
 *   · 两个请求同时发布同一实体 → 都算出同一个 nextVersion →
 *     后者写 ContentRevision 触发 P2002 → 409，事务回滚，线上版本不受影响。
 *   · 发布期间他人保存草稿 → 草稿被清除后其保存会重建草稿（不丢数据），
 *     但该次保存不会影响已发布的线上版本。
 */
export async function publishEntity<TRow extends PublishableRow>(
  prisma: PrismaService,
  adapter: PublishAdapter<TRow>,
  id: string,
  actorId: string | null,
  note?: string,
): Promise<PublishResult<TRow>> {
  const before = await adapter.findRow(id);
  if (!before) throw new NotFoundException(`${adapter.label}不存在`);

  const draft: DraftRecord | null = await readDraft(prisma, adapter.entityType, id);
  const payload = (draft?.payload ?? null) as Record<string, unknown> | null;
  const nextVersion = before.publishedVersion + 1;

  let result: PublishResult<TRow>;
  try {
    result = await prisma.$transaction(async (tx) => {
      // 1) 应用编辑稿（无草稿则原样取当前行）
      const applied = await adapter.applyDraft(id, payload, tx);

      // 2) 服务端发布校验：不能只靠前端提示
      adapter.validate(applied);

      // 3) 切换状态 + 推进版本
      const published = await adapter.markPublished(id, nextVersion, tx);

      // 4) 清编辑稿（历史已入 revision）
      await clearDraft(tx, adapter.entityType, id);

      // 5) 落发布快照
      await appendRevision(
        tx,
        adapter.entityType,
        id,
        nextVersion,
        adapter.toSnapshot(published),
        actorId,
        note,
      );

      return {
        row: published,
        publishedVersion: nextVersion,
        // 发布成功编辑稿已清空 → 不存在未发布修改
        hasUnpublishedChanges: false,
        draftVersion: null,
      };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException(
        `${adapter.label}已被他人发布（版本冲突），请刷新后重试`,
      );
    }
    throw error;
  }

  return result;
}

/** 取消发布：只改状态，不删内容、不删历史、不删编辑稿 */
export async function unpublishEntity<TRow extends PublishableRow>(
  prisma: PrismaService,
  adapter: PublishAdapter<TRow>,
  id: string,
): Promise<PublishResult<TRow>> {
  const before = await adapter.findRow(id);
  if (!before) throw new NotFoundException(`${adapter.label}不存在`);

  // 只切状态并推进乐观锁版本号：内容、发布历史、编辑稿全部保留，
  // 因此可以随时重新发布回同一版本内容。
  const row = await prisma.$transaction((tx) => adapter.markUnpublished(id, tx));

  // 编辑稿保留：重新发布时可原样恢复
  const draft = await readDraft(prisma, adapter.entityType, id);
  return {
    row,
    publishedVersion: row.publishedVersion,
    hasUnpublishedChanges: draft !== null,
    draftVersion: draft?.version ?? null,
  };
}

/** 预览：线上版本 + 编辑稿（仅后台授权访问） */
export async function previewEntity<TRow extends PublishableRow>(
  prisma: PrismaService,
  adapter: PublishAdapter<TRow>,
  id: string,
  toPublic: (row: TRow) => unknown,
) {
  const row = await adapter.findRow(id);
  if (!row) throw new NotFoundException(`${adapter.label}不存在`);

  const draft = await readDraft(prisma, adapter.entityType, id);
  return {
    entity: toPublic(row),
    draft: draft?.payload ?? null,
    draftVersion: draft?.version ?? null,
    publishedVersion: row.publishedVersion,
    status: row.status,
    hasUnpublishedChanges: draft !== null,
  };
}

/** 发布历史（倒序） */
export function listEntityRevisions<TRow extends PublishableRow>(
  prisma: PrismaService,
  adapter: PublishAdapter<TRow>,
  id: string,
  take = 20,
) {
  return listRevisions(prisma, adapter.entityType, id, take);
}

/** 发布前校验：字符串必填 */
export function requireText(value: unknown, field: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`发布失败：${label}的「${field}」不能为空`);
  }
}

/** 发布前校验：关联必填 */
export function requireRelation(value: unknown, field: string, label: string): void {
  if (value === null || value === undefined || value === '') {
    throw new BadRequestException(`发布失败：${label}必须指定「${field}」`);
  }
}

/**
 * 从请求头解析编辑稿版本号（乐观锁）。
 *
 * 约定：`X-Draft-Version: <n>`。前端保存时带上上次读到的 draftVersion，
 * 服务端比对不一致即 409，避免「后写覆盖先写」。
 * 未提供 → 返回 undefined，表示不做版本校验（兼容旧客户端）。
 */
export function draftVersionFrom(headers: Record<string, unknown> | undefined): number | undefined {
  const raw = headers?.['x-draft-version'];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
