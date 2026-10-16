import type { RevalidationService } from '../../src/modules/revalidation/revalidation.service';

/**
 * 单元测试专用的 RevalidationService 替身。
 *
 * Phase 4.8 起，所有 CMS 写入服务都在构造函数中注入了 `RevalidationService`，
 * 用于「发布即刷新」通知前台失效缓存。单元测试只关心数据库读写与业务规则，
 * 不应真实发起 HTTP 请求，因此统一注入本替身：
 *   - `invalidate` 恒返回 `true`（模拟「已通知」），且默认 resolve，绝不抛异常。
 *   - 测试如需断言调用，可用 `mock.invalidate.mock.calls` 检查。
 */
export function makeRevalidationMock() {
  return {
    invalidate: jest.fn().mockResolvedValue(true),
  } as unknown as RevalidationService;
}
