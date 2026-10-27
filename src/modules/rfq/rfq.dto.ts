import { Rfq, RfqNotifyStatus, RfqStatus } from '@prisma/client';

/**
 * RFQ API 的对外契约（DTO）。
 *
 * 分成两组，避免公开接口泄漏后台字段：
 *   · 公开（POST 创建回执）：仅返回 id / status / createdAt —— 不回声任何客户信息
 *   · 后台（GET 列表 / 详情）：返回完整询盘内容，供管理后台跟进
 */

/* -------------------------------- 公开回执 -------------------------------- */

/** POST /api/v1/rfq 成功后的最小回执（不含客户隐私字段） */
export interface RfqReceiptDto {
  id: string;
  status: RfqStatus;
  createdAt: string;
}

export function toRfqReceipt(rfq: Rfq): RfqReceiptDto {
  return {
    id: rfq.id,
    status: rfq.status,
    createdAt: rfq.createdAt.toISOString(),
  };
}

/* -------------------------------- 后台视图 -------------------------------- */

/** 列表项：后台表格展示所需字段 */
export interface RfqListItemDto {
  id: string;
  name: string;
  company: string;
  email: string;
  country: string;
  phone: string | null;
  productId: string | null;
  productName: string | null;
  quantity: string | null;
  status: RfqStatus;
  createdAt: string;
  updatedAt: string;
  /** 承接人（Phase 4.6 自动分配；未分配时全部为 null） */
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  assignedAt: string | null;
  /** 通知邮件投递状态（后台「通知」列 + 详情页补发用） */
  notifyStatus: RfqNotifyStatus;
  /** 最近一次成功发送时间 */
  notifiedAt: string | null;
  /** 最近一次失败的错误摘要（成功时为 null） */
  notifyError: string | null;
  /** 已尝试发送次数（含自动首发与人工补发） */
  notifyAttempts: number;
}

/** 详情：列表项 + 需求正文与附件 */
export interface RfqDetailDto extends RfqListItemDto {
  message: string;
  attachmentUrl: string | null;
}

/** 分页信封 */
export interface PaginatedRfqDto {
  items: RfqListItemDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/* -------------------------------- mappers -------------------------------- */

/** 询盘 + 承接人关联（Phase 4.6；不带关联查询时该字段缺省为 undefined） */
type RfqRow = Rfq & {
  assignee?: { id: string; name: string | null; email: string } | null;
};

/** 后台接口统一的承接人关联查询 */
export const RFQ_ASSIGNEE_SELECT = {
  assignee: { select: { id: true, name: true, email: true } },
} as const;

export function toRfqListItem(rfq: RfqRow): RfqListItemDto {
  const assignee = rfq.assignee ?? null;
  return {
    id: rfq.id,
    name: rfq.name,
    company: rfq.company,
    email: rfq.email,
    country: rfq.country,
    phone: rfq.phone,
    productId: rfq.productId,
    productName: rfq.productName,
    quantity: rfq.quantity,
    status: rfq.status,
    createdAt: rfq.createdAt.toISOString(),
    updatedAt: rfq.updatedAt.toISOString(),
    assigneeId: assignee?.id ?? rfq.assigneeId ?? null,
    assigneeName: assignee?.name ?? null,
    assigneeEmail: assignee?.email ?? null,
    assignedAt: rfq.assignedAt ? rfq.assignedAt.toISOString() : null,
    notifyStatus: rfq.notifyStatus,
    notifiedAt: rfq.notifiedAt ? rfq.notifiedAt.toISOString() : null,
    notifyError: rfq.notifyError,
    notifyAttempts: rfq.notifyAttempts,
  };
}

export function toRfqDetail(rfq: RfqRow): RfqDetailDto {
  return {
    ...toRfqListItem(rfq),
    message: rfq.message,
    attachmentUrl: rfq.attachmentUrl,
  };
}
