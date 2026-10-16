import { ConfigService } from '@nestjs/config';
import { RevalidationService } from '../src/modules/revalidation/revalidation.service';
import { CmsTags, SITE_PAGE_PATH } from '../src/modules/revalidation/cms-tags';

/**
 * 前台缓存失效服务测试（Phase 4.8）。
 *
 * 覆盖任务书第八~十二节的关键约束：
 *   · 未配置 URL / SECRET 时静默关闭（本地开发与单测不会因此失败）
 *   · 已配置时以 POST + secret 头调用前台 /api/revalidate
 *   · 前台返回非 2xx、网络异常、超时 —— 一律**不抛异常**（不影响内容写入）
 *   · tags / paths 去重；两者都为空时不发请求
 *   · tag 契约与前台 bailing-ui 的 lib/cms-tags.ts 保持一致
 */

/** 构造一个只认识两个配置键的 ConfigService 替身 */
function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    frontendRevalidateUrl: '',
    revalidateSecret: '',
    ...overrides,
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const ENABLED_CONFIG = {
  frontendRevalidateUrl: 'http://127.0.0.1:3000/api/revalidate',
  revalidateSecret: 'test-secret-0123456789abcdef',
};

describe('RevalidationService（Phase 4.8）', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('启用条件', () => {
    it('未配置 URL 与 SECRET 时关闭，且不发起任何请求', async () => {
      const service = new RevalidationService(makeConfig());
      expect(service.isEnabled()).toBe(false);
      await expect(service.invalidate({ tags: [CmsTags.products] })).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('只配置 URL 或只配置 SECRET 时同样关闭', async () => {
      const onlyUrl = new RevalidationService(
        makeConfig({ frontendRevalidateUrl: ENABLED_CONFIG.frontendRevalidateUrl }),
      );
      const onlySecret = new RevalidationService(
        makeConfig({ revalidateSecret: ENABLED_CONFIG.revalidateSecret }),
      );
      expect(onlyUrl.isEnabled()).toBe(false);
      expect(onlySecret.isEnabled()).toBe(false);
    });

    it('两者齐备时启用', () => {
      const service = new RevalidationService(makeConfig(ENABLED_CONFIG));
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('请求构造', () => {
    it('以 POST + secret 头调用前台端点，并透传 tags / paths', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const service = new RevalidationService(makeConfig(ENABLED_CONFIG));

      const ok = await service.invalidate({
        tags: [CmsTags.products, CmsTags.product('abc')],
        paths: ['/products', '/products/abc'],
      });

      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(ENABLED_CONFIG.frontendRevalidateUrl);
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-revalidate-secret']).toBe(ENABLED_CONFIG.revalidateSecret);
      expect(headers['content-type']).toBe('application/json');

      const body = JSON.parse(String(init.body)) as {
        secret: string;
        tags: string[];
        paths: string[];
        revalidateLayout: boolean;
      };
      expect(body.secret).toBe(ENABLED_CONFIG.revalidateSecret);
      expect(body.tags).toEqual(['products', 'product:abc']);
      expect(body.paths).toEqual(['/products', '/products/abc']);
      expect(body.revalidateLayout).toBe(false);
    });

    it('tags / paths 去重并剔除空白项', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const service = new RevalidationService(makeConfig(ENABLED_CONFIG));

      await service.invalidate({
        tags: ['products', 'products', '  ', 'product:x'],
        paths: ['/products', '/products'],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { tags: string[]; paths: string[] };
      expect(body.tags).toEqual(['products', 'product:x']);
      expect(body.paths).toEqual(['/products']);
    });

    it('导航类变更以 layout 粒度失效', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const service = new RevalidationService(makeConfig(ENABLED_CONFIG));

      await service.invalidate({
        tags: [CmsTags.navigation],
        paths: ['/'],
        revalidateLayout: true,
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { revalidateLayout: boolean };
      expect(body.revalidateLayout).toBe(true);
    });

    it('tags 与 paths 均为空时不发请求', async () => {
      const service = new RevalidationService(makeConfig(ENABLED_CONFIG));
      await expect(service.invalidate({})).resolves.toBe(false);
      await expect(service.invalidate({ tags: ['  '], paths: [] })).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('失败处理（绝不抛出，不影响内容写入）', () => {
    it('前台返回 401 / 403 时返回 false 而非抛异常', async () => {
      const service = new RevalidationService(makeConfig(ENABLED_CONFIG));

      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      await expect(service.invalidate({ tags: [CmsTags.products] })).resolves.toBe(false);

      fetchMock.mockResolvedValue({ ok: false, status: 403 });
      await expect(service.invalidate({ tags: [CmsTags.products] })).resolves.toBe(false);
    });

    it('前台不可达（网络异常）时返回 false 而非抛异常', async () => {
      const service = new RevalidationService(makeConfig(ENABLED_CONFIG));
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.invalidate({ tags: [CmsTags.products] })).resolves.toBe(false);
    });

    it('前台 503（密钥未配置）时返回 false', async () => {
      const service = new RevalidationService(makeConfig(ENABLED_CONFIG));
      fetchMock.mockResolvedValue({ ok: false, status: 503 });
      await expect(service.invalidate({ paths: ['/'] })).resolves.toBe(false);
    });
  });

  describe('tag / path 契约（必须与前台 bailing-ui 一致）', () => {
    it('实体 tag 使用 冒号 前缀形式', () => {
      expect(CmsTags.product('mdf-board')).toBe('product:mdf-board');
      expect(CmsTags.blogPost('post-1')).toBe('blog:post-1');
      expect(CmsTags.application('kitchen')).toBe('application:kitchen');
    });

    it('静态 tag 与前台逐字一致', () => {
      expect([
        CmsTags.products,
        CmsTags.categories,
        CmsTags.blog,
        CmsTags.blogCategories,
        CmsTags.applications,
        CmsTags.factory,
        CmsTags.quality,
        CmsTags.site,
        CmsTags.navigation,
        CmsTags.contacts,
      ]).toEqual([
        'products',
        'categories',
        'blog',
        'blog-categories',
        'applications',
        'factory',
        'quality',
        'site',
        'navigation',
        'contacts',
      ]);
    });

    it('站点页面路径映射完整', () => {
      expect(SITE_PAGE_PATH.HOME).toBe('/');
      expect(SITE_PAGE_PATH.ABOUT).toBe('/about');
      expect(SITE_PAGE_PATH.CONTACT).toBe('/contact');
    });
  });
});
