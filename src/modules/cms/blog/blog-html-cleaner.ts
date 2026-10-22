/**
 * 存量博客正文 / 摘要清洗管线（纯函数，无 IO —— 供回填脚本与单测复用）
 *
 * 背景见 prisma/scripts/clean-blog-legacy-html.ts 头部注释与
 * bailing-ui/docs/article-style-diff-report.md。
 *
 * 与 rich-text.sanitizer 的分工：
 *   · sanitizer 管「安全 + 卫生」的写入端白名单（CMS 保存时执行）；
 *   · 本模块管「存量数据的受控迁移」（回填脚本用）：emoji 还原、盒式标题
 *     转受控 class、表格滚动容器，最后仍过一次 sanitizer 保证属性卫生。
 */
import { sanitizeRichText } from './rich-text.sanitizer';

/* ------------------------------ 实体 / 文本 ------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** 解码数字实体与常见命名实体；未知实体原样保留 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 去标签 / 注释 → 纯文本（标签边界空格并入后续标点，避免 "plywood ."） */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+([.,;:!?%])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取正文第一个段落的文本（无 <p> 时退化为整篇文本） */
export function firstParagraphText(html: string): string {
  const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  return htmlToText(p ? p[1] : html);
}

/** 长度兜底：优先句子边界，其次词边界；不追加省略号 */
export function truncateAtBoundary(text: string, max = 300): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
  );
  if (sentenceEnd >= Math.floor(max * 0.5)) return head.slice(0, sentenceEnd + 1).trim();
  const wordEnd = head.lastIndexOf(' ');
  return (wordEnd >= Math.floor(max * 0.6) ? head.slice(0, wordEnd) : head).trim();
}

/** WP 自动摘要的截断标记（实体解码后的形态）：`[…]` / `[...]` / 行尾裸 `…` */
const TRUNCATION_MARKER = /\[(?:…|\.\.\.)\]$|…$/;

/**
 * 摘要清洗：自动截断摘要（解码后以 […] 结尾或为空）→ 用正文首段重建；
 * 人工摘要仅做实体解码 + 长度兜底（不改写语义、不添加原文没有的内容）。
 */
export function cleanBlogExcerpt(raw: string | null | undefined, contentHtml: string): string {
  const normalized = raw ? truncateAtBoundary(htmlToText(decodeHtmlEntities(raw))) : '';
  const isAutoTruncated = normalized.length === 0 || TRUNCATION_MARKER.test(normalized);
  if (isAutoTruncated) {
    const fromContent = truncateAtBoundary(firstParagraphText(contentHtml));
    if (fromContent.length > 0) return fromContent;
    return normalized.replace(TRUNCATION_MARKER, '').trim().replace(/[\s,;:–-]+$/, '');
  }
  return normalized;
}

/* ------------------------------ 正文变换 ------------------------------ */

/** emoji img → Unicode 字符（仅 s.w.org / twemoji 且 alt 为 emoji；其余一律不动） */
const EMOJI_IMG_SRC = /(?:s\.w\.org\/images\/core\/emoji|twemoji)/i;
const EMOJI_CHAR = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

export function replaceEmojiImages(html: string): { html: string; count: number } {
  let count = 0;
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1] ?? '';
    if (!EMOJI_IMG_SRC.test(src)) return tag;
    const altAttr = /\balt="([^"]*)"/i.exec(tag)?.[1];
    if (altAttr === undefined) return tag; // 无 alt 不猜，保留原样
    const alt = decodeHtmlEntities(altAttr);
    if (alt.length === 0 || alt.length > 4 || !EMOJI_CHAR.test(alt)) return tag;
    count += 1;
    return alt;
  });
  return { html: out, count };
}

/** 盒式标题（内联 border-left + 背景）→ 受控 class prose-boxed-heading */
export function normalizeBoxedHeadings(html: string): { html: string; count: number } {
  let count = 0;
  const out = html.replace(/<h([1-6])\b([^>]*)>/gi, (tag, level: string, attrs: string) => {
    const style = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!style) return tag;
    const css = (style[2] ?? style[3] ?? '').toLowerCase();
    const isBoxed = css.includes('border-left') && (css.includes('background') || css.includes('background-color'));
    if (!isBoxed) return tag;
    count += 1;
    return `<h${level} class="prose-boxed-heading">`;
  });
  return { html: out, count };
}

/** <table> 包裹 prose-table-scroll 容器（已包裹的跳过，保证幂等） */
export function wrapTables(html: string): { html: string; count: number } {
  let count = 0;
  const re = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const before = html.slice(Math.max(0, m.index - 60), m.index);
    out += html.slice(last, m.index);
    if (/prose-table-scroll["'>][^<]*$/.test(before)) {
      out += m[0]; // 已在滚动容器内
    } else {
      out += `<div class="prose-table-scroll">${m[0]}</div>`;
      count += 1;
    }
    last = m.index + m[0].length;
  }
  out += html.slice(last);
  return { html: out, count };
}

/**
 * 正文清洗管线（幂等：相同输入重复执行结果一致）。
 * 顺序：emoji 还原 → 盒式标题受控化 → sanitizer 属性卫生 → 表格滚动容器。
 */
export function cleanBlogContentHtml(raw: string): string {
  const step1 = replaceEmojiImages(raw);
  const step2 = normalizeBoxedHeadings(step1.html);
  const step3 = sanitizeRichText(step2.html);
  return wrapTables(step3).html;
}

/** 统计用：各规则命中次数（不改变输出，供 dry-run 报告） */
export function analyzeBlogContentHtml(raw: string): {
  emoji: number;
  boxed: number;
  tables: number;
  polluted: boolean;
} {
  const emoji = replaceEmojiImages(raw).count;
  const boxed = normalizeBoxedHeadings(raw).count;
  const afterSanitize = sanitizeRichText(normalizeBoxedHeadings(replaceEmojiImages(raw).html).html);
  const tables = wrapTables(afterSanitize).count;
  const polluted = /class=|style=|srcset=|data-attachment/.test(raw);
  return { emoji, boxed, tables, polluted };
}
