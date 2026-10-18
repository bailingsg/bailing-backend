export interface InventoryItemDto {
  id: string;
  /** 库存编号（系统生成，全局唯一） */
  code: string;
  productName: string;
  productDetail: string;
  /** 数量（Decimal 序列化为字符串，避免浮点精度损失） */
  quantity: string;
  unit: string;
  location: string;
  storedAt: Date;
  /** 关联订单 ID（可空） */
  orderId: string | null;
  /** 关联订单号（从关联订单实时读取，可空） */
  orderCode: string | null;
  createdById: string;
  creatorName: string | null;
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
