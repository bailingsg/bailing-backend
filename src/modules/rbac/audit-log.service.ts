import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ActorContext } from './actor-context';

/** 审计日志入参 */
export interface AuditEntry {
  /** 操作人（系统自动触发时传 null） */
  actor?: Pick<ActorContext, 'id' | 'email'> | null;
  /** 动作标识，如 `role.permissions.update` / `account.disable` / `lead_plan.close` */
  action: string;
  /** 目标类型，如 `Role` / `AdminUser` / `LeadDistributionPlan` */
  targetType: string;
  /** 目标 id */
  targetId?: string | null;
  /** 变更前后差异（强烈建议提供；敏感字段须脱敏） */
  diff?: unknown;
  /** 人类可读摘要（中文） */
  summary?: string | null;
  /** 关联的倾斜计划（用于计划操作历史） */
  planId?: string | null;
}

/**
 * 审计日志服务（Phase 4.6）。
 *
 * 写入策略：
 *   · 审计写入失败**不阻断**主业务（仅记 error 日志），
 *     避免「日志表故障 → 无法管理角色」这类可用性问题
 *   · 所有角色/权限/账号/计划的重要变更都必须调用本服务
 *   · diff 中禁止出现口令、口令哈希等敏感值（调用方负责脱敏）
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 写入审计日志。
   *
   * @param tx 可选：随业务事务一起提交（用于「分配 + 计划自动完成」这类必须原子化的场景）。
   *           不传则独立提交——审计失败不阻断主业务。
   */
  async record(entry: AuditEntry, tx?: PrismaService | Prisma.TransactionClient): Promise<void> {
    try {
      const client = tx ?? this.prisma;
      await client.auditLog.create({
        data: {
          actorId: entry.actor?.id ?? null,
          actorEmail: entry.actor?.email ?? null,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          diff: entry.diff === undefined ? undefined : (entry.diff as never),
          summary: entry.summary ?? null,
          planId: entry.planId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `审计日志写入失败: action=${entry.action} target=${entry.targetType}:${entry.targetId ?? '-'}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** 查询针对某目标的审计记录（倒序分页） */
  async listForTarget(targetType: string, targetId: string, take = 20) {
    return this.prisma.auditLog.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** 查询某计划的全部操作历史 */
  async listForPlan(planId: string, take = 50) {
    return this.prisma.auditLog.findMany({
      where: { planId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
