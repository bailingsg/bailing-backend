import { OrderCurrency } from '@prisma/client';

export interface OrderAttachmentDto {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: Date;
}

export interface OrderDto {
  id: string;
  code: string;
  salespersonId: string;
  salespersonName: string | null;
  customerName: string;
  country: string;
  requirement: string;
  orderedAt: Date;
  closedAt: Date | null;
  amount: string; // Decimal 序列化为字符串，避免浮点精度损失
  currency: OrderCurrency;
  note: string | null;
  attachments: OrderAttachmentDto[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
