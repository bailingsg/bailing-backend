import {
  analyzeBlogContentHtml,
  cleanBlogContentHtml,
  cleanBlogExcerpt,
  decodeHtmlEntities,
  firstParagraphText,
  htmlToText,
} from './blog-html-cleaner';

/**
 * 存量清洗管线单元测试（Phase：文章样式整改）
 * 覆盖：emoji 还原 / 盒式标题受控化 / 属性卫生 / 表格容器 / 幂等 / 摘要重建。
 */
describe('cleanBlogContentHtml', () => {
  it('emoji img 还原为 Unicode；普通图片原样保留', () => {
    const out = cleanBlogContentHtml('<p>Hi <img class="emoji" src="https://s.w.org/images/core/emoji/16.0.1/svg/1f4e7.svg" alt="📧"> there</p>');
    expect(out).toBe('<p>Hi 📧 there</p>');
    const normal = cleanBlogContentHtml('<p><img src="/uploads/a.webp" alt="Melamine Plywood" width="300" height="300"></p>');
    expect(normal).toContain('src="/uploads/a.webp"');
    expect(normal).toContain('width="300"');
    expect(normal).not.toContain('s.w.org');
  });

  it('emoji 图无 alt 或 alt 非 emoji 时不替换（防误判）', () => {
    const noAlt = '<img class="emoji" src="https://s.w.org/images/core/emoji/16.0.1/svg/1f4e7.svg">';
    expect(cleanBlogContentHtml(noAlt)).toContain('<img');
    const notEmoji = '<img src="https://s.w.org/images/core/emoji/16.0.1/svg/1f4e7.svg" alt="logo image">';
    expect(cleanBlogContentHtml(notEmoji)).toContain('alt="logo image"');
  });

  it('盒式标题内联样式 → 受控 class（视觉语义保留给 .blog-prose）', () => {
    const out = cleanBlogContentHtml(
      '<h2 style="border-left: 6px solid #2b7a8a; background-color: #f5f7fa; padding: 15px">1. Title</h2><p>x</p>',
    );
    expect(out).toBe('<h2 class="prose-boxed-heading">1. Title</h2><p>x</p>');
  });

  it('普通带 style/class 标题 → 样式与 class 全部清除', () => {
    const out = cleanBlogContentHtml('<h2 class="text-[1.2rem] font-bold mt-4 text-zinc-800 dark:text-zinc-200" style="color:red">T</h2>');
    expect(out).toBe('<h2>T</h2>');
  });

  it('表格包裹 prose-table-scroll；wp-image/data-attachment/srcset 被剥', () => {
    const out = cleanBlogContentHtml(
      '<table data-x="1"><tr><td>a</td></tr></table><img class="alignnone wp-image-1240 size-medium" src="/a.webp" srcset="/a.webp 300w, /a.webp 768w" data-attachment-id="1240" alt="a">',
    );
    expect(out).toContain('<div class="prose-table-scroll"><table><tr><td>a</td></tr></table></div>');
    expect(out).not.toContain('wp-image');
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('data-attachment');
  });

  it('幂等：清洗两次结果一致', () => {
    const raw =
      '<p>Intro <img class="emoji" src="https://s.w.org/images/core/emoji/16.0.1/svg/1f4e7.svg" alt="📧"></p>' +
      '<h3 class="mt-4" style="border-left:4px solid #333;background:#eee">Boxed</h3>' +
      '<table><tr><th>H</th></tr></table>' +
      '<p class="ds-markdown-paragraph"><span class="">tail</span></p>';
    const once = cleanBlogContentHtml(raw);
    const twice = cleanBlogContentHtml(once);
    expect(twice).toBe(once);
    expect(once).not.toContain('ds-markdown-paragraph');
  });

  it('内容完整性：文字/链接/层级/图片顺序不丢', () => {
    const raw =
      '<h2>Keep heading</h2><p>Text with <a href="https://x.com">link</a> and <strong>bold</strong>.</p>' +
      '<ul><li>one</li><li>two</li></ul><img src="/1.webp" alt="first"><img src="/2.webp" alt="second">';
    const out = cleanBlogContentHtml(raw);
    expect(out).toContain('<h2>Keep heading</h2>');
    expect(out).toContain('<a href="https://x.com">link</a>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<li>one</li>');
    expect(out.indexOf('/1.webp')).toBeLessThan(out.indexOf('/2.webp'));
  });
});

describe('cleanBlogExcerpt', () => {
  const content = '<p>Full first paragraph about plywood and WBP glue ratings for marine use.</p><p>Second.</p>';

  it('WP 自动摘要（实体+截断标记）→ 正文首段重建', () => {
    const out = cleanBlogExcerpt('Plywood guide starts here and cuts off [&hellip;]', content);
    expect(out).toBe('Full first paragraph about plywood and WBP glue ratings for marine use.');
  });

  it('人工摘要 → 仅实体解码，语义保留', () => {
    expect(cleanBlogExcerpt('A &amp; B &mdash; guide.', content)).toBe('A & B — guide.');
  });

  it('空摘要 → 正文首段', () => {
    expect(cleanBlogExcerpt(null, content)).toContain('Full first paragraph');
  });

  it('截断但无正文可用 → 去标记不留字面量', () => {
    expect(cleanBlogExcerpt('Cut here [&hellip;]', '')).toBe('Cut here');
  });

  it('超长人工摘要 → 300 字符边界截断，不加省略号', () => {
    const out = cleanBlogExcerpt('word '.repeat(100), '');
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(false);
  });
});

describe('文本工具', () => {
  it('decodeHtmlEntities 覆盖命名 + 数字实体，未知实体保留', () => {
    expect(decodeHtmlEntities('&#8217;&hellip;&#x41;&unknown;')).toBe('’…A&unknown;');
  });
  it('htmlToText 去标签并合并标点前空格', () => {
    expect(htmlToText('<p>a <strong>b</strong>.</p>')).toBe('a b.');
  });
  it('firstParagraphText 取第一个 <p>', () => {
    expect(firstParagraphText('<div>skip</div><p>Real first.</p>')).toBe('Real first.');
  });
});

describe('analyzeBlogContentHtml（dry-run 统计）', () => {
  it('统计各规则命中', () => {
    const stats = analyzeBlogContentHtml(
      '<p><img class="emoji" src="https://s.w.org/images/core/emoji/16.0.1/svg/1f4e7.svg" alt="📧"></p>' +
        '<h2 style="border-left:2px solid red;background:#fff">B</h2><table><tr><td>t</td></tr></table>',
    );
    expect(stats).toEqual({ emoji: 1, boxed: 1, tables: 1, polluted: true });
  });
});
