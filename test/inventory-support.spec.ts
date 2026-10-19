import { BadRequestException } from '@nestjs/common';
import { generateInventoryCode, toInventoryQuantity } from '../src/modules/inventory/inventory.support';

/**
 * 库存写入共享工具单测（Phase 5.3.2）。
 *
 * 这两个函数是「库存模块」与「订单表单联动库存」的共同底座：
 * 规则一旦漂移，同一条库存从两个入口写入就会出现不同结果，因此单独锁死。
 */
describe('inventory.support', () => {
  describe('generateInventoryCode', () => {
    it('格式为 INV-YYYYMMDD-XXXXXX，日期取传入时间', () => {
      const code = generateInventoryCode(new Date(2026, 9, 19, 8, 30));
      expect(code).toMatch(/^INV-20261019-[A-F0-9]{6}$/);
    });

    it('连续生成基本不重复（随机空间 16^6）', () => {
      const codes = new Set(Array.from({ length: 200 }, () => generateInventoryCode()));
      expect(codes.size).toBeGreaterThan(195);
    });
  });

  describe('toInventoryQuantity', () => {
    it('非负数量原样转 Decimal，并保留三位小数精度', () => {
      expect(toInventoryQuantity(0).toFixed(3)).toBe('0.000');
      expect(toInventoryQuantity(12.125).toFixed(3)).toBe('12.125');
      expect(toInventoryQuantity('88.5').toFixed(3)).toBe('88.500');
      expect(toInventoryQuantity(120).toFixed(3)).toBe('120.000');
    });

    it('负数被拒绝', () => {
      expect(() => toInventoryQuantity(-1)).toThrow(BadRequestException);
      expect(() => toInventoryQuantity(-0.001)).toThrow('数量不允许为负数');
    });

    it('超过三位小数被拒绝', () => {
      expect(() => toInventoryQuantity(1.2345)).toThrow(BadRequestException);
      expect(() => toInventoryQuantity(1.2345)).toThrow('数量最多保留三位小数');
    });

    it('非数字被拒绝（Decimal 构造失败）', () => {
      expect(() => toInventoryQuantity('一百')).toThrow();
    });
  });
});
