/**
 * 富文本（HTML）净化器 —— 白名单机制，防 XSS 内容注入。
 *
 * 设计原则：
 *   · 标签白名单：仅保留内容排版所需标签；危险元素（script/style/iframe/svg/...）
 *     连同内部内容整体丢弃
 *   · 属性白名单：逐标签限定；事件处理器（on*）、style、class、id、data-* 一律丢弃
 *   · URL 白名单：href/src 仅允许 http / https / mailto 与相对地址；
 *     javascript: / data: / vbscript: / file: 等一律剔除
 *   · 先做 HTML 实体解码再判协议，防止 &#106;avascript: / java&#09;script: 绕过
 *   · target="_blank" 时强制补 rel="noopener noreferrer"（防 reverse tabnabbing）
 *
 * 本模块为纯函数、零第三方依赖（与项目「不引入外部净化库」的既有约定一致）。
 * 输出为「安全的 HTML 子集」，可直接由公开站 v-html / dangerouslySetInnerHTML 渲染。
 */

/** 允许保留的标签（内容排版子集） */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'strike',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'a',
  'img',
  'figure',
  'figcaption',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'span',
  'div',
]);

/** 空元素（无闭合标签） */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * 危险元素：连同内部内容整体丢弃。
 *
 * 注意：html / head / body 不在此列 —— 它们只是文档外壳（从 Word/网页粘贴时常见），
 * 标签本身会被丢弃、内部正文保留，避免用户内容被整段吞掉。
 * head 中的 title / meta 已单独列入本集合。
 */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'link',
  'meta',
  'base',
  'title',
  'frame',
  'frameset',
]);

/** 危险元素中的空元素：只丢弃标签本身，绝不吞掉后续内容（否则会误伤整篇正文） */
const DROP_VOID = new Set(['meta', 'base', 'link', 'input']);

/** 逐标签属性白名单（未列出的标签不允许任何属性） */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel', 'class']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'class', 'loading']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  p: new Set(['class']),
  h1: new Set(['class']),
  h2: new Set(['class']),
  h3: new Set(['class']),
  h4: new Set(['class']),
  h5: new Set(['class']),
  h6: new Set(['class']),
  ul: new Set(['class']),
  ol: new Set(['class']),
  li: new Set(['class']),
  blockquote: new Set(['class']),
  pre: new Set(['class']),
  table: new Set(['class']),
  figure: new Set(['class']),
  figcaption: new Set(['class']),
  div: new Set(['class']),
};

/**
 * 受控排版 class 白名单（正文样式唯一入口）。
 *
 * 背景：Phase 5.4 迁移的存量正文 HTML 里混有来源不受控的 class
 * （Tailwind 工具类、wp-image-*、ds-markdown-paragraph 等），会与新站
 * Tailwind utilities 层冲突、造成文章间排版不一致（见 docs/article-style-diff-report.md D-03）。
 * 清洗管线把这些"有视觉语义但属性不受控"的结构转换为下列受控 class 后重新入库；
 * 为避免 CMS 再次保存时被 sanitizer 剥掉（样式静默丢失)，这里只放行这一组
 * **命名空间封闭**的 class —— 历史上被剥掉的其它 class 仍然一律剥掉，行为不变。
 */
export const PROSE_ALLOWED_CLASSES = new Set([
  'prose-boxed-heading', // 盒式标题（旧内联 border-left + 背景的受控替代）
  'prose-table-scroll', // 宽表格横向滚动容器
]);

/** img.loading 合法值（其余按缺省处理，不写入） */
const IMG_LOADING_VALUES = new Set(['lazy', 'eager']);

/** 需要做协议校验的属性 */
const URL_ATTRS = new Set(['href', 'src']);

/** 允许的 URL 协议（其余一律拒绝；无协议的相对地址另行放行） */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** 合法 HTML 实体（用于「只转义裸 &」的负向断言） */
const ENTITY_LOOKAHEAD = '(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\\d+|#x[0-9a-fA-F]+);)';

/** 净化入口：非法输入（非字符串）返回空串 */
export function sanitizeRichText(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  let out = '';
  let i = 0;
  const n = input.length;

  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out += escapeText(input.slice(i));
      break;
    }
    if (lt > i) out += escapeText(input.slice(i, lt));

    // 注释：整段丢弃
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // DOCTYPE / 处理指令：丢弃
    if (input[lt + 1] === '!' || input[lt + 1] === '?') {
      const end = input.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const header = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(input.slice(lt, Math.min(n, lt + 128)));
    if (!header) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }

    const closing = header[1] === '/';
    const tag = header[2].toLowerCase();
    const tagEnd = findTagEnd(input, lt);
    if (tagEnd === -1) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }

    const attrStart = lt + 1 + (closing ? 1 : 0) + tag.length;
    const rawAttrs = input.slice(attrStart, tagEnd);
    const selfClosing = input[tagEnd - 1] === '/';
    i = tagEnd + 1;

    if (DROP_WITH_CONTENT.has(tag)) {
      // 空元素（meta/base/link/input）与自闭合写法没有配对闭合标签，
      // 若仍去查找闭合标签会一路吞到文末 —— 必须排除。
      if (!closing && !selfClosing && !DROP_VOID.has(tag)) {
        const closeRe = new RegExp(`</\\s*${tag}\\b[^>]*>`, 'i');
        const rest = input.slice(i);
        const cm = closeRe.exec(rest);
        i = cm ? i + cm.index + cm[0].length : n;
      }
      continue;
    }

    // 白名单外的普通标签：丢弃标签本身，保留内部文本（内部文本会走转义）
    if (!ALLOWED_TAGS.has(tag)) continue;

    if (closing) {
      if (!VOID_TAGS.has(tag)) out += `</${tag}>`;
      continue;
    }

    out += `<${tag}${sanitizeAttrs(tag, rawAttrs)}>`;
  }

  return out;
}

/** 从 '<' 起找到标签结束的 '>'，跳过引号内的内容；未闭合返回 -1 */
function findTagEnd(s: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

/** 解析属性区为 [{name, value}]（容忍无引号、单引号、双引号与裸属性） */
function parseAttributes(raw: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    out.push({ name: m[1], value });
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

/** 按标签白名单过滤属性，输出可直接拼接的 " k=\"v\"" 片段 */
function sanitizeAttrs(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return '';

  const parts: string[] = [];
  let targetBlank = false;

  for (const { name, value } of parseAttributes(raw)) {
    const key = name.toLowerCase();
    if (!allowed.has(key)) continue;

    if (key === 'class') {
      // 只保留受控排版 class token；污染 token 逐个剔除（部分保留，不做一票否决）
      const kept = value.split(/\s+/).filter((token) => PROSE_ALLOWED_CLASSES.has(token));
      if (kept.length > 0) parts.push(`class="${escapeAttr(kept.join(' '))}"`);
      continue;
    }

    if (key === 'loading' && tag === 'img') {
      const v = value.trim().toLowerCase();
      if (IMG_LOADING_VALUES.has(v)) parts.push(`loading="${v}"`);
      continue;
    }

    if (URL_ATTRS.has(key)) {
      const safe = sanitizeUrl(value);
      if (safe === null) continue;
      parts.push(`${key}="${escapeAttr(safe)}"`);
      continue;
    }

    if (key === 'target') {
      if (value.trim().toLowerCase() === '_blank') {
        parts.push('target="_blank"');
        targetBlank = true;
      }
      continue;
    }

    // rel 由 target 统一生成，避免作者传入 rel="opener"
    if (key === 'rel') continue;

    parts.push(`${key}="${escapeAttr(value)}"`);
  }

  if (tag === 'a' && targetBlank) parts.push('rel="noopener noreferrer"');
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** URL 协议白名单：解码实体 → 去控制字符/空白 → 判协议 */
function sanitizeUrl(raw: string): string | null {
  const decoded = stripInvisible(decodeEntities(raw));
  if (decoded === '') return null;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(decoded);
  if (scheme) {
    return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? decoded : null;
  }

  // 无协议：相对地址（/path、#hash、?q、path.html、../x）
  return /^[#/?]/.test(decoded) || /^[a-zA-Z0-9._-]/.test(decoded) ? decoded : null;
}

/**
 * 去除不可见字符（控制字符 + 空白 + DEL）。
 *
 * 必须剔除的原因：浏览器解析 URL 时会忽略其中的制表符/换行/NUL，
 * 于是 `java&#09;script:` 这类拼接会被当作 `javascript:` 执行 —— 先归一化再判协议。
 * 实现刻意使用字符码过滤而非正则字面量，以规避 no-control-regex lint 规则。
 */
function stripInvisible(s: string): string {
  return s
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x20 && code !== 0x7f;
    })
    .join('');
}

/** HTML 实体解码（数字实体 + 常见命名实体） */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body: string) => {
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

/** 文本节点转义：仅转义裸 & 与尖括号，保留既有合法实体 */
function escapeText(s: string): string {
  return s
    .replace(new RegExp(`&${ENTITY_LOOKAHEAD}`, 'g'), '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 属性值转义 */
function escapeAttr(s: string): string {
  return s
    .replace(new RegExp(`&${ENTITY_LOOKAHEAD}`, 'g'), '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
