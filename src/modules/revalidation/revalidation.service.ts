import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 前台内容缓存失效服务（Phase 4.8）
 *
 * 职责：CMS 内容发生变更（发布 / 下架 / 删除 / 编辑）后，通知前台
 * （bailing-ui 的 POST /api/revalidate）失效对应的 tag / path，
 * 使访客下一次访问立即看到最新内容——无需重建，也无需手动清 `.next/cache`。
 *
 * 设计要点（对应任务书第八、九、十二节）：
 *   · **绝不抛出异常**：内容写入已经成功，通知失败不能影响后台操作，
 *     也不能让管理员看到「保存失败」的假象。失败只记警告日志。
 *   · **未配置即降级**：FRONTEND_REVALIDATE_URL / REVALIDATE_SECRET 任一缺失时
 *     整个能力静默关闭（本地开发 / 单元测试不会因此失败）。
 *   · **有超时**：前台不可达时不能让请求挂起，默认 3 秒。
 */

/** 通知超时（毫秒） */
const TIMEOUT_MS = 3000;

export interface RevalidatePayload {
  /** 需要失效的缓存标签（见 ./cms-tags.ts，须与前台逐字一致） */
  tags?: string[];
  /** 需要失效的页面路径 */
  paths?: string[];
  /** 是否以 layout 粒度失效（导航等影响全站的变更） */
  revalidateLayout?: boolean;
}

@Injectable()
export class RevalidationService {
  private readonly logger = new Logger(RevalidationService.name);
  private readonly url: string;
  private readonly secret: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.url = (this.config.get<string>('frontendRevalidateUrl') ?? '').trim();
    this.secret = (this.config.get<string>('revalidateSecret') ?? '').trim();
    this.enabled = Boolean(this.url && this.secret);

    if (this.enabled) {
      this.logger.log(`前台缓存失效已启用 → ${this.url}`);
    } else {
      this.logger.warn('前台缓存失效未启用（缺少 FRONTEND_REVALIDATE_URL / REVALIDATE_SECRET）');
    }
  }

  /** 当前是否启用（供健康检查 / 测试断言使用） */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 触发前台缓存失效。
   *
   * @returns 是否成功送达（仅用于日志/测试，调用方**无需**关心失败）
   */
  async invalidate(payload: RevalidatePayload): Promise<boolean> {
    if (!this.enabled) return false;

    const tags = dedupe(payload.tags ?? []);
    const paths = dedupe(payload.paths ?? []);
    if (tags.length === 0 && paths.length === 0) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-secret': this.secret,
        },
        body: JSON.stringify({
          secret: this.secret,
          tags,
          paths,
          revalidateLayout: payload.revalidateLayout === true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 不回显响应体（可能含内部信息），只记录状态码
        this.logger.warn(`前台缓存失效被拒绝：HTTP ${response.status}（tags=${tags.join(',')}）`);
        return false;
      }

      this.logger.log(
        `前台缓存已失效：tags=[${tags.join(', ')}] paths=[${paths.join(', ')}]${
          payload.revalidateLayout ? ' (layout)' : ''
        }`,
      );
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`前台缓存失效通知失败（不影响本次内容写入）：${reason}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function dedupe(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);
}
