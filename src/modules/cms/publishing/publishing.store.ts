import { ConflictException } from '@nestjs/common';
import type { ContentEntityType, Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * 发布工作流的通用存储操作（Phase 1）。
 *
 * 只做三件事：读写编辑稿、追加发布版本、查询历史。
 * 实体自身的字段映射仍由各模块 Service 负责（避免通用表反向依赖业务模型）。
 */

export interface DraftRecord {
  id: string;
  payload: Prisma.JsonValue;
  version: number;
  baseVersion: number;
  updatedAt: Date;
}

/** 读取编辑稿（不存在返回 null） */
export async function readDraft(
  prisma: PrismaService,
  entityType: ContentEntityType,
  entityId: string,
): Promise<DraftRecord | null> {
  const row = await prisma.contentDraft.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { id: true, payload: true, version: true, baseVersion: true, updatedAt: true },
  });
  return row;
}

/**
 * 保存编辑稿（upsert）。
 * expectedVersion 传入时做乐观锁：与当前编辑稿版本不一致 → 409，避免静默覆盖他人修改。
 */
export async function saveDraftPayload(
  prisma: PrismaService,
  entityType: ContentEntityType,
  entityId: string,
  payload: unknown,
  actorId: string | null,
  expectedVersion?: number,
  baseVersion = 0,
): Promise<DraftRecord> {
  const current = await readDraft(prisma, entityType, entityId);

  if (expectedVersion !== undefined && current && current.version !== expectedVersion) {
    throw new ConflictException(
      `编辑稿已被他人修改（当前 v${current.version}，提交基于 v${expectedVersion}），请刷新后重试`,
    );
  }

  const data = payload as Prisma.InputJsonValue;

  if (current) {
    return prisma.contentDraft.update({
      where: { entityType_entityId: { entityType, entityId } },
      data: {
        payload: data,
        version: { increment: 1 },
        updatedById: actorId,
      },
      select: { id: true, payload: true, version: true, baseVersion: true, updatedAt: true },
    });
  }

  return prisma.contentDraft.create({
    data: {
      entityType,
      entityId,
      payload: data,
      baseVersion,
      updatedById: actorId,
    },
    select: { id: true, payload: true, version: true, baseVersion: true, updatedAt: true },
  });
}

/** 发布成功后清除编辑稿（历史已由 revision 保存） */
export async function clearDraft(
  tx: Prisma.TransactionClient,
  entityType: ContentEntityType,
  entityId: string,
): Promise<void> {
  await tx.contentDraft.deleteMany({ where: { entityType, entityId } });
}

/** 追加一条发布版本（version 唯一，重复发布同一版本会抛 P2002） */
export async function appendRevision(
  tx: Prisma.TransactionClient,
  entityType: ContentEntityType,
  entityId: string,
  version: number,
  snapshot: unknown,
  actorId: string | null,
  note?: string,
): Promise<void> {
  await tx.contentRevision.create({
    data: {
      entityType,
      entityId,
      version,
      snapshot: snapshot as Prisma.InputJsonValue,
      publishedById: actorId,
      note: note ?? null,
    },
  });
}

/** 发布历史（倒序，含快照摘要由调用方裁剪） */
export async function listRevisions(
  prisma: PrismaService,
  entityType: ContentEntityType,
  entityId: string,
  take = 20,
) {
  return prisma.contentRevision.findMany({
    where: { entityType, entityId },
    orderBy: { version: 'desc' },
    take,
    select: {
      id: true,
      version: true,
      action: true,
      publishedById: true,
      publishedAt: true,
      note: true,
      snapshot: true,
    },
  });
}
