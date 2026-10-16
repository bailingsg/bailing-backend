import type { LeadAssignmentSource, LeadPlanStatus, RoleStatus } from '@prisma/client';

/** 正常轮询队列中的一名员工 */
export interface QueueMemberDto {
  adminUserId: string;
  name: string | null;
  email: string;
  /** 账号是否启用（队列只含启用中账号，此字段用于提示） */
  isActive: boolean;
  /** 队列序号（0-based，前端展示 1,2,3…） */
  index: number;
  /** 该员工累计承接的询盘数（不含历史） */
  assignedTotal: number;
}

/** 倾斜计划中的员工条目（进度全部来自真实后端数据） */
export interface PlanItemProgressDto {
  adminUserId: string;
  name: string | null;
  email: string;
  jobTitle: string | null;
  targetCount: number;
  /** 已成功分配数量（真实计数） */
  assignedCount: number;
  /** 剩余数量 */
  remainingCount: number;
  /** 完成百分比（0–100，整数） */
  completionPercent: number;
  /** 员工账号当前是否启用 */
  isEmployeeActive: boolean;
  /** 是否仍是有效询盘联系人（账号启用且被标记为询盘联系人） */
  isEligible: boolean;
  /** 队列序号（用于说明分配顺序） */
  sortOrder: number;
}

/** 倾斜计划详情 */
export interface PlanDto {
  id: string;
  name: string;
  status: LeadPlanStatus;
  mode: string;
  startAt: Date;
  endAt: Date | null;
  totalTarget: number;
  /** 计划总完成量（各员工 assignedCount 之和） */
  totalAssigned: number;
  /** 总完成百分比 */
  completionPercent: number;
  cooldownSeconds: number;
  closedAt: Date | null;
  resumeAt: Date | null;
  /** 是否已过自动恢复时间（冷却结束） */
  isCooldownElapsed: boolean;
  /** 计划当前是否真正生效（决定分配模式；false = 待生效 / 冷却暂停中 / 已完成） */
  isInEffect: boolean;
  /** 是否仍有可接单的倾斜员工（false = 全部已达标或账号停用，实际已回落正常轮询） */
  hasTiltCapacity: boolean;
  /** 是否在等待生效时间到达（startAt 在未来） */
  isPendingStart: boolean;
  /** 是否在冷却暂停中等待自动恢复 */
  isPendingResume: boolean;
  /** 关闭操作者邮箱（无则为空） */
  closedByEmail: string | null;
  createdByEmail: string | null;
  items: PlanItemProgressDto[];
  createdAt: Date;
  updatedAt: Date;
}

/** 询盘分配主状态（前端 /lead-distribution 页面唯一数据源） */
export interface LeadDistributionStateDto {
  /** 当前分配模式：ROUND_ROBIN（正常轮询）/ PRIORITY_PLAN（倾斜计划中） */
  currentMode: LeadAssignmentSource;
  /** 正常轮询队列（仅可分配员工） */
  queue: QueueMemberDto[];
  /** 队列长度 */
  queueLength: number;
  /** 下一位正常轮询承接人（队列为空时为 null） */
  nextAssignee: {
    adminUserId: string;
    name: string | null;
    email: string;
    index: number;
  } | null;
  /** 当前生效的倾斜计划（无则 null） */
  activePlan: PlanDto | null;
  /** 最近分配记录 */
  recentAssignments: AssignmentDto[];
  /** 近 7 天每日分配量（运营趋势，真实数据） */
  dailyStats: { date: string; count: number }[];
  /** 累计分配总数 */
  totalAssigned: number;
  /** 尚未分配承接人的询盘数 */
  unassignedCount: number;
}

/** 一条询盘分配记录 */
export interface AssignmentDto {
  id: string;
  rfqId: string;
  /** 询盘摘要（客户姓名/公司，供列表展示） */
  rfqSummary: {
    name: string;
    company: string;
    country: string;
    productName: string | null;
    status: string;
  };
  assignee: {
    adminUserId: string;
    name: string | null;
    email: string;
  };
  source: LeadAssignmentSource;
  /** 正常轮询时的队列位置 */
  roundRobinIndex: number | null;
  planId: string | null;
  planName: string | null;
  createdAt: Date;
}

/** 分页分配历史 */
export interface PaginatedAssignmentsDto {
  items: AssignmentDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** 计划操作历史（来自审计日志） */
export interface PlanLogDto {
  id: string;
  action: string;
  actorEmail: string | null;
  summary: string | null;
  diff: unknown;
  createdAt: Date;
}

/** 创建计划结果 */
export interface CreatePlanResultDto {
  plan: PlanDto;
  assigned: number;
  skipped: string[];
}

/** 员工可分配性（创建计划前的预检数据源） */
export interface EligibleAssigneeDto {
  adminUserId: string;
  name: string | null;
  email: string;
  jobTitle: string | null;
  /** 账号是否启用 */
  isActive: boolean;
  /** 是否被标记为询盘联系人（参与正常轮询队列） */
  isLeadContact: boolean;
  /** 累计承接询盘数 */
  assignedTotal: number;
  /** 是否已在某个生效中的计划里 */
  inActivePlan: boolean;
  /** 在当前生效计划中的剩余目标量（不在计划中为 null） */
  remainingInActivePlan: number | null;
  /** 在正常轮询队列中的位置（-1 = 不在队列） */
  queueIndex: number;
}

/** 角色状态枚举（用于内部类型提示） */
export type { LeadPlanStatus, RoleStatus };
