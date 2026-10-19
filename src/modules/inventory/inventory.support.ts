import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

/**
 * 库存写入的共享底层工具（Phase 5.3.2）。
 *
 * 订单表单联动创建/更新库存时，必须与库存模块自身的校验规则完全一致：
 *   · 库存编号格式 INV-YYYYMMDD-XXXXXX（同日 6 位十六进制随机，唯一索引兜底）；
 *   · 数量为非负 Decimal，最多三位小数（Decimal(14,3) 存储，杜绝浮点误差）。
 *
 * 因此把这两条规则收敛到本文件，由 InventoryService 与 OrdersService 共用，
 * 避免两处实现漂移。
 */

/**
 * 生成库存编号：INV-YYYYMMDD-XXXXXX。
 *
 * 随机空间为 16^6 ≈ 1677 万/天，碰撞概率极低；真正的唯一性由
 * inventory_items.code 唯一索引保证，调用方需处理 P2002 并重试。
 */
export function generateInventoryCode(now: Date = new Date()): string {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const rand = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `INV-${ymd}-${rand}`;
}

/**
 * 数量归一：非负 + 最多三位小数，返回可直接落库的 Decimal。
 * 与 CreateInventoryDto 的 @Min(0) / maxDecimalPlaces:3 形成双重保障
 * （DTO 拦在入口，本函数拦住服务层被内部调用时绕过 DTO 的情况）。
 */
export function toInventoryQuantity(value: number | string): Prisma.Decimal {
  const quantity = new Prisma.Decimal(value);
  if (quantity.isNegative()) {
    throw new BadRequestException('数量不允许为负数');
  }
  if (quantity.decimalPlaces() > 3) {
    throw new BadRequestException('数量最多保留三位小数');
  }
  return quantity;
}
