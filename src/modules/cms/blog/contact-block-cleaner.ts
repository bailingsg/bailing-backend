/**
 * 正文写死联系方式清洗器（纯函数）
 *
 * 背景：Phase 5.4 从 WordPress 迁移时把源站正文原样入库，文章末尾带着写死的
 * 联系方式签名块（产品/公司电话与邮箱）。这些信息本应来自 CMS（员工联系卡
 * / 站点设置），写死在正文里会随人员与号码变更而过期，且会把内部号码暴露给
 * 搜索引擎。本模块负责把这些块从存量 HTML 中确定性移除。
 *
 * 已识别的三种形态：
 *   A. 签名段（10 篇）：
 *      <p><span>📧 </span><strong><span>Email:<a href="https://wa.me/8613...">+86 131 ...</a></span></strong><br>
 *         <span>🌐 </span><strong><span>Website:</span></strong>...<br>
 *         <span>📍 </span><strong><span>Factory:</span></strong><span> Shouguang City...</span></p>
 *   B. 旧站页脚块（2 篇）：
 *      <div><a href="https://wa.me/8613..."><span><span></span><span>WhatsApp+8613...</span></span></a></div>
 *   C. CTA 列表（1 篇）：
 *      <ul><li><strong>Email:</strong> <span>bailing@bailingwoods.com</span></li>...</ul>
 *
 * 设计原则：
 *   · 只删「联系方式载体」元素本身，不动正文段落与其它结构；
 *   · 移除后再做一次残留文本兜底（号码 / 邮箱 / wa.me 链接）；
 *   · 幂等：对已清洗内容再跑一次，输出与输入完全一致。
 */

/** 写死的号码与邮箱（含源站错标的 "Email:+86..." 与缺空格的 "WhatsApp+86..."） */
const CONTACT_LITERALS = [
  /WhatsApp\+?86[\d\s-]*/gi,
  /\+86\s?131\s?5688\s?9006/g,
  /8613156889006/g,
  /bailing@bailingwoods\.com/gi,
];

/**
 * A：整段签名（📧 / 🌐 / 📍 三行在同一个 <p> 内）
 * 变体：公司名 + 标语在前、📧 行在后（from-log-to-finished-board 一篇），
 * 因此按「含 📧 的段落」整体移除，而不是要求 <p> 紧接 📧。
 */
const SIGNATURE_BLOCK =
  /<p[^>]*>(?:(?!<\/p>)[\s\S])*?📧(?:(?!<\/p>)[\s\S])*?<\/p>/gi;

/** B：wa.me 锚点（含内部 "WhatsApp+8613..." 文本） */
const WHATSAPP_ANCHOR = /<a\b[^>]*href="https?:\/\/wa\.me\/[^"]*"[\s\S]*?<\/a>/gi;

/** C：CTA 列表里写死邮箱的那一条 */
const EMAIL_LIST_ITEM = /<li[^>]*>\s*<strong[^>]*>\s*Email:?\s*<\/strong>[\s\S]*?<\/li>/gi;

export interface StripContactsResult {
  html: string;
  /** 命中的规则名，便于脚本汇总与排障 */
  hits: string[];
}

/** 从正文 HTML 中移除写死的联系方式块 */
export function stripHardcodedContacts(html: string): StripContactsResult {
  const hits: string[] = [];
  let out = html;

  if (SIGNATURE_BLOCK.test(out)) {
    hits.push('signature-block');
    out = out.replace(SIGNATURE_BLOCK, '');
  }
  if (WHATSAPP_ANCHOR.test(out)) {
    hits.push('whatsapp-anchor');
    out = out.replace(WHATSAPP_ANCHOR, '');
  }
  if (EMAIL_LIST_ITEM.test(out)) {
    hits.push('email-list-item');
    out = out.replace(EMAIL_LIST_ITEM, '');
  }

  for (const literal of CONTACT_LITERALS) {
    if (literal.test(out)) {
      hits.push(`literal:${literal.source}`);
      out = out.replace(literal, '');
    }
  }

  // 移除后可能留下空段落（<p></p> / <p> </p>）——只清空段落，不动 <div> 结构
  out = out.replace(/<p[^>]*>\s*<\/p>/gi, '');

  return { html: out, hits };
}

/** 是否仍含写死联系方式（用于校验与幂等断言） */
export function hasHardcodedContacts(html: string): boolean {
  if (/wa\.me\//i.test(html)) return true;
  if (/📧/.test(html)) return true;
  if (/bailing@bailingwoods\.com/i.test(html)) return true;
  if (/13156889006/.test(html)) return true;
  return false;
}

/* -------------------------------------------------------------------------- *
 * 经验年限宣传语（"26 years of experience" 一类写死表述）
 *
 * 这类表述与写死联系方式同源：都是旧站正文里的营销样板话术，年数会过期，
 * 且与 CMS 侧维护的公司信息重复。此处按「语法安全」原则改写而非硬删：
 *   · "we have 26 years of experience manufacturing engineered wood." → "we manufacture engineered wood."
 *   · ", with over 26 years of experience in wood processing," → ","
 *   · "With over 20 years of experience, " → ""
 *   · "With our 26-year legacy, we" → "We"
 *   · "(26 years of experience)" → ""
 *   · 列表项整条都是年限/资历声明时，整条移除（保持列表结构合法）
 * 不触碰正文中的数据型表述（如 "20-Year Maintenance & Repair Cost" 表头）。
 * -------------------------------------------------------------------------- */

const EXPERIENCE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/we have \d+\+? years? of experience manufacturing engineered wood\./gi, 'we manufacture engineered wood.'],
  [/\s*,\s*with (?:over )?\d+\+? years? of experience in wood processing\s*,/gi, ','],
  [/with (?:over )?\d+\+? years? of experience,\s*/gi, ''],
  [/with our \d+-year legacy,\s*we/gi, 'We'],
  [/\s*\(\d+\+? years? of experience\)/gi, ''],
  [/we have \d+\+? years? of experience/gi, 'we have extensive experience'],
  // 产品正文的编号段落形态："1. We have  17 years of experience in export board 7 years  of alibaba golden supplier."
  [
    /We have\s+\d+\s*years? of experience[^<.]*\./gi,
    'We have extensive experience in wood board manufacturing and export.',
  ],
];

/** 列表项内容整体是年限/资历声明时整条移除 */
const CLAIM_LIST_ITEM = /<li[^>]*>[\s\S]*?<\/li>/gi;
const CLAIM_TEXT = /years? of experience|Alibaba Gold Supplier/i;

export interface StripClaimsResult {
  html: string;
  hits: string[];
}

/** 移除写死的经验年限宣传语 */
export function stripExperienceClaims(html: string): StripClaimsResult {
  const hits: string[] = [];
  let out = html;

  for (const [pattern, replacement] of EXPERIENCE_RULES) {
    if (pattern.test(out)) {
      hits.push(`claim:${pattern.source}`);
      out = out.replace(pattern, replacement);
    }
  }

  // 整条 li 都是资历声明时移除（保留同列表其它条目）
  if (CLAIM_TEXT.test(out)) {
    const before = out;
    out = out.replace(CLAIM_LIST_ITEM, (item) => (CLAIM_TEXT.test(item) ? '' : item));
    if (out !== before) hits.push('claim-list-item');
  }

  // 兜底：仍带资历声明（如 alibaba golden supplier）且长度很短的段落整段移除
  out = out.replace(/<p[^>]*>[\s\S]*?<\/p>/gi, (paragraph) =>
    /alibaba golden supplier/i.test(paragraph) && paragraph.length < 300 ? '' : paragraph,
  );

  // 移除后清掉空列表与空段落
  out = out.replace(/<[uo]l[^>]*>\s*<\/[uo]l>/gi, '');
  out = out.replace(/<p[^>]*>\s*<\/p>/gi, '');

  return { html: out, hits };
}

/**
 * 解除指向第三方 B2B 平台的外链（如公司阿里巴巴店铺页）。
 *
 * 处理分两种形态：
 *   1. 锚点内是文字（`<a ...><strong>waterproof wall cladding</strong></a>`）
 *      → 「解包」：保留内部文字与加粗语义，只去掉跳转，正文语句不受影响。
 *   2. 锚点内只有一张图片（产品正文尾部的阿里巴巴店铺横幅：
 *      `<div><a href="https://bailingwood.en.alibaba.com/"><img src="...alicdn..."></a></div>`）
 *      → 「整块移除」：解包只会留下指向 alicdn 的孤儿图片，链接的语义就是
 *        这张宣传图本身，应连同锚点一起删除，并清掉因此空掉的包裹 <div>。
 * 只作用于 alibaba.com / alicdn.com 两个已知平台域，不触碰其它外链。
 */
const EXTERNAL_COMMERCIAL_HOSTS = ['alibaba.com', 'alicdn.com'];
const EXTERNAL_ANCHOR = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
/** 锚点内部「仅有图片（允许空白）」——宣传图外链的判定 */
const IMAGE_ONLY_INNER = /^\s*<img\b[^>]*>\s*$/i;

function isExternalCommercialHost(href: string): boolean {
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    return false;
  }
  return EXTERNAL_COMMERCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function unwrapExternalCommercialLinks(html: string): { html: string; hits: number } {
  let hits = 0;
  let out = html.replace(EXTERNAL_ANCHOR, (match, href: string, inner: string) => {
    if (!isExternalCommercialHost(href)) return match;
    hits += 1;
    // 图片型外链整块移除（锚点 + 三方图片），文字型外链仅解包
    return IMAGE_ONLY_INNER.test(inner) ? '' : inner;
  });
  // 仅在真的移除了图片型外链时收敛空包裹层（<div><div></div></div>）：
  // 逐层删除「内容仅为空白」的 div 直到稳定。无命中时原样返回，
  // 保证未命中内容的 CMS 重存往返恒等。
  if (hits > 0) {
    let prev = '';
    while (prev !== out) {
      prev = out;
      out = out.replace(/<div[^>]*>\s*<\/div>/gi, '');
    }
  }
  return { html: out, hits };
}

/** 是否仍含经验年限宣传语 */
export function hasExperienceClaims(html: string): boolean {
  return /years? of experience/i.test(html) || /-year legacy/i.test(html);
}
