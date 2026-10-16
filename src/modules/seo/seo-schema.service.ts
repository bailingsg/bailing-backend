import { BadRequestException, Injectable } from '@nestjs/common';

/**
 * Schema 数据安全校验（Phase 5.0，任务书二十五节）
 *
 * 管理员在后台填写的 schemaData 是**字符串**，前后端双重白名单校验后才入库 / 输出：
 *   · 只接受 FAQ 条目数组：[{ question, answer }, ...]（最多 20 条，每条 ≤ 500 字符）；
 *   · 拒绝任何含 HTML 标签（< >）的内容——前台以 JSON.stringify 安全序列化输出，
 *     但入口即拦截，双保险防 XSS / 注入；
 *   · 任何不合法输入直接 400，绝不「猜测意图」后放行。
 */
@Injectable()
export class SeoSchemaService {
  /** FAQ 条目最大值 */
  private static readonly MAX_FAQ_ITEMS = 20;
  private static readonly MAX_FAQ_TEXT = 500;

  /**
   * 校验并规范化 schemaData 字符串。
   * @returns 规范化后的 JSON 字符串；输入为空时返回 null
   */
  normalizeSchemaData(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    const trimmed = raw.trim();
    if (trimmed === '') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new BadRequestException('schemaData 不是合法的 JSON');
    }

    if (!Array.isArray(parsed)) {
      throw new BadRequestException('schemaData 仅支持 FAQ 条目数组 [{question, answer}]');
    }
    if (parsed.length > SeoSchemaService.MAX_FAQ_ITEMS) {
      throw new BadRequestException(`FAQ 条目最多 ${SeoSchemaService.MAX_FAQ_ITEMS} 条`);
    }

    const items = parsed.map((entry) => this.normalizeFaqItem(entry));
    return JSON.stringify(items);
  }

  private normalizeFaqItem(entry: unknown): { question: string; answer: string } {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestException('FAQ 条目必须是对象 {question, answer}');
    }
    const row = entry as Record<string, unknown>;
    const question = this.cleanText(row.question, 'question');
    const answer = this.cleanText(row.answer, 'answer');
    return { question, answer };
  }

  private cleanText(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`FAQ 条目的 ${field} 必须是字符串`);
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new BadRequestException(`FAQ 条目的 ${field} 不能为空`);
    }
    if (trimmed.length > SeoSchemaService.MAX_FAQ_TEXT) {
      throw new BadRequestException(`FAQ 条目的 ${field} 超过 ${SeoSchemaService.MAX_FAQ_TEXT} 字符`);
    }
    if (trimmed.includes('<') || trimmed.includes('>')) {
      throw new BadRequestException(`FAQ 条目的 ${field} 不允许包含 HTML 标签`);
    }
    return trimmed;
  }

  /**
   * 校验并规范化 relatedData 字符串（内联管理）。
   * 形态：{ products?: [slug], posts?: [slug], applications?: [slug] }，每类最多 6 个 slug。
   */
  normalizeRelatedData(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    const trimmed = raw.trim();
    if (trimmed === '') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new BadRequestException('relatedData 不是合法的 JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestException('relatedData 必须是对象 { products?, posts?, applications? }');
    }

    const row = parsed as Record<string, unknown>;
    const result: { products?: string[]; posts?: string[]; applications?: string[] } = {};
    for (const key of ['products', 'posts', 'applications'] as const) {
      const value = row[key];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value) || value.length > 6) {
        throw new BadRequestException(`relatedData.${key} 必须是数组且最多 6 项`);
      }
      const slugs: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item)) {
          throw new BadRequestException(`relatedData.${key} 包含非法 slug：${String(item)}`);
        }
        if (!slugs.includes(item)) slugs.push(item);
      }
      result[key] = slugs;
    }
    return JSON.stringify(result);
  }
}
