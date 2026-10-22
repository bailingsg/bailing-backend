import { sanitizeRichText, PROSE_ALLOWED_CLASSES } from './rich-text.sanitizer';

/**
 * rich-text.sanitizer 单元测试（Phase：文章样式整改）
 *
 * 重点验证「受控排版 class 白名单」行为：
 *   · prose-boxed-heading / prose-table-scroll 保留（清洗管线的受控输出；
 *     CMS 再次保存不得丢样式）；
 *   · 历史污染 class（Tailwind 工具类 / wp-image-* / ds-markdown-paragraph /
 *     dark: 变体）继续一律剥掉——这是文章间排版不一致（D-03）的根治点；
 *   · style / data-* / srcset / id 继续剥掉；
 *   · 混合 class（受控 + 污染）整属性丢弃，不做部分保留（避免半干净状态）。
 */
describe('sanitizeRichText — prose class whitelist', () => {
  it('保留受控 class prose-boxed-heading', () => {
    const out = sanitizeRichText('<h2 class="prose-boxed-heading">Title</h2>');
    expect(out).toBe('<h2 class="prose-boxed-heading">Title</h2>');
  });

  it('保留受控 class prose-table-scroll（div 容器）', () => {
    const out = sanitizeRichText('<div class="prose-table-scroll"><table><tr><td>x</td></tr></table></div>');
    expect(out).toContain('<div class="prose-table-scroll">');
    expect(out).toContain('<table>');
  });

  it('剥掉 Tailwind 工具类（历史污染）', () => {
    const out = sanitizeRichText('<h2 class="text-[1.2rem] font-bold mt-4 text-zinc-800 dark:text-zinc-200">T</h2>');
    expect(out).toBe('<h2>T</h2>');
  });

  it('剥掉 wp-image-* / ds-markdown-paragraph；混合 class 只保留受控 token', () => {
    expect(sanitizeRichText('<img src="/a.png" class="wp-image-12 size-medium" alt="a">')).toBe(
      '<img src="/a.png" alt="a">',
    );
    expect(sanitizeRichText('<p class="ds-markdown-paragraph">text</p>')).toBe('<p>text</p>');
    // 杂类不影响受控 class 生效（部分保留，不做“一票否决”）
    expect(sanitizeRichText('<h2 class="prose-boxed-heading mt-4">T</h2>')).toBe(
      '<h2 class="prose-boxed-heading">T</h2>',
    );
  });

  it('继续剥掉 style / data-* / srcset / id', () => {
    const out = sanitizeRichText(
      '<h2 id="x" style="border-left:6px solid #2b7a8a" data-foo="1" class="prose-boxed-heading">T</h2>',
    );
    expect(out).toBe('<h2 class="prose-boxed-heading">T</h2>');
    const img = sanitizeRichText('<img src="/a.png" srcset="/a.png 300w, /a.png 768w" style="width:10px">');
    expect(img).toBe('<img src="/a.png">');
  });

  it('img.loading 只接受 lazy/eager', () => {
    expect(sanitizeRichText('<img src="/a.png" loading="lazy" alt="a">')).toBe('<img src="/a.png" loading="lazy" alt="a">');
    expect(sanitizeRichText('<img src="/a.png" loading="bogus" alt="a">')).toBe('<img src="/a.png" alt="a">');
  });

  it('暴露白名单集合内容（供清洗脚本引用一致性检查）', () => {
    expect([...PROSE_ALLOWED_CLASSES].sort()).toEqual(['prose-boxed-heading', 'prose-table-scroll']);
  });
});

describe('sanitizeRichText — 既有安全行为不回归', () => {
  it('剥 script / 事件属性 / 危险协议', () => {
    expect(sanitizeRichText('<p onclick="x()">a</p><script>alert(1)</script>')).toBe('<p>a</p>');
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichText('<a href="https://ok.com" target="_blank">x</a>')).toBe(
      '<a href="https://ok.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it('保留 img 宽高与 a 的 href', () => {
    expect(sanitizeRichText('<img src="/a.png" width="300" height="200" alt="a">')).toBe(
      '<img src="/a.png" width="300" height="200" alt="a">',
    );
  });
});
