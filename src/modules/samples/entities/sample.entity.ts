import { SampleRequestStatus, SampleStatus } from '@prisma/client';

/** 样品 DTO（列表 / 详情共用） */
export interface SampleDto {
  id: string;
  code: string;
  name: string;
  spec: string | null;
  material: string | null;
  usage: string | null;
  quantity: number;
  unit: string;
  location: string;
  remark: string | null;
  status: SampleStatus;
  ownerId: string;
  ownerName: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 样品详情（含授权名单与待审批申请） */
export interface SampleDetailDto extends SampleDto {
  grants: {
    id: string;
    granteeId: string;
    granteeName: string | null;
    grantedById: string;
    createdAt: Date;
  }[];
  pendingRequest: {
    id: string;
    requesterId: string;
    requesterName: string | null;
    purpose: string;
    createdAt: Date;
  } | null;
}

/** 出库申请 DTO */
export interface SampleRequestDto {
  id: string;
  sampleId: string;
  sampleCode: string;
  sampleName: string;
  requesterId: string;
  requesterName: string | null;
  ownerId: string;
  ownerName: string | null;
  purpose: string;
  status: SampleRequestStatus;
  decidedById: string | null;
  decidedAt: Date | null;
  withdrawnAt: Date | null;
  createdAt: Date;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
