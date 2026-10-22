import {
  unwrapExternalCommercialLinks,
  hasExperienceClaims,
  hasHardcodedContacts,
  stripExperienceClaims,
  stripHardcodedContacts,
} from './contact-block-cleaner';

const SIGNATURE = `<p>Keep this paragraph.</p>
<p><span>📧 </span><strong><span>Email:<a href="https://wa.me/8613156889006">+86 131 5688 9006</a></span></strong><br>
<span>🌐 </span><strong><span>Website:</span></strong><span> </span><a href="https://bailingwooden.com/" target="_blank" rel="noopener noreferrer"><span>bailingwooden.com</span></a><br>
<span>📍 </span><strong><span>Factory:</span></strong><span> Shouguang City, Shandong Province, China (26 years of experience)</span></p>`;

const LEGACY_FOOTER = `<div><p><strong>Conclusion:</strong> Real content.</p></div>
<div>
  <div><ul><li><span></span><span> Bailing Wood • 2026</span></li></ul></div>
  <div><a href="https://wa.me/8613156889006"><span><span></span><span>WhatsApp+8613156889006</span></span></a></div>
  <div><a href="/contact-us/"><span><span></span><span>Contact Bailing Wood </span></span></a></div>
</div>`;

const CTA_LIST = `<p><strong>Ready to start?</strong></p>
<ul>
<li><strong>Email:</strong> <span>bailing@bailingwoods.com</span></li>
<li><strong>Website:</strong> <a href="https://bailingwooden.com/">https://bailingwooden.com/</a></li>
</ul>`;

describe('stripHardcodedContacts', () => {
  it('移除 📧/🌐/📍 签名段，保留正文段落', () => {
    const { html, hits } = stripHardcodedContacts(SIGNATURE);
    expect(hits).toContain('signature-block');
    expect(html).toContain('Keep this paragraph.');
    expect(html).not.toContain('📧');
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain('131 5688 9006');
    expect(html).not.toContain('Factory:');
  });

  it('移除旧站页脚里的 WhatsApp 锚点，保留 Contact 链接与署名', () => {
    const { html, hits } = stripHardcodedContacts(LEGACY_FOOTER);
    expect(hits).toContain('whatsapp-anchor');
    expect(html).toContain('Real content.');
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain('WhatsApp+86');
    expect(html).toContain('/contact-us/');
    expect(html).toContain('Bailing Wood • 2026');
  });

  it('移除 CTA 列表里写死邮箱的 li，保留 Website 条目', () => {
    const { html, hits } = stripHardcodedContacts(CTA_LIST);
    expect(hits).toContain('email-list-item');
    expect(html).not.toContain('bailing@bailingwoods.com');
    expect(html).toContain('Website:');
  });

  it('移除「公司名+标语在前、📧 行在后」的签名变体', () => {
    const variant = `<p><strong><span>Shouguang Bailing Wood Industry Co., Ltd.</span></strong><br>
<em><span>Professional manufacturer of premium veneered panels</span></em><br>
<span>📧 </span><strong><span>Email:</span></strong><br>
<span>🌐 </span><strong><span>Website:</span></strong><span> </span><a href="https://bailingwooden.com/">bailingwooden.com</a></p>`;
    const { html, hits } = stripHardcodedContacts(variant);
    expect(hits).toContain('signature-block');
    expect(html).not.toContain('📧');
    expect(html).not.toContain('bailingwooden.com');
  });

  it('幂等：二次清洗输出与首次一致', () => {
    for (const sample of [SIGNATURE, LEGACY_FOOTER, CTA_LIST]) {
      const once = stripHardcodedContacts(sample).html;
      const twice = stripHardcodedContacts(once).html;
      expect(twice).toBe(once);
    }
  });

  it('不误伤正常内容：表格、标题、普通链接、正文中的数字', () => {
    const safe = `<h2>Title</h2><table><tbody><tr><td>18mm</td><td>1220×2440</td></tr></tbody></table>
<p>Contact our team via the <a href="/contact">contact page</a> for details. Lead time 15 days.</p>`;
    const { html, hits } = stripHardcodedContacts(safe);
    expect(hits).toHaveLength(0);
    expect(html).toBe(safe);
  });

  it('清空移除后产生的空段落', () => {
    const { html } = stripHardcodedContacts('<p>a</p><p><span>📧</span><span>x</span></p><p></p><p>b</p>');
    expect(html).toBe('<p>a</p><p>b</p>');
  });

  it('hasHardcodedContacts 判定', () => {
    expect(hasHardcodedContacts(SIGNATURE)).toBe(true);
    expect(hasHardcodedContacts(LEGACY_FOOTER)).toBe(true);
    expect(hasHardcodedContacts(CTA_LIST)).toBe(true);
    expect(hasHardcodedContacts('<p>clean</p>')).toBe(false);
  });
});

describe('stripExperienceClaims', () => {
  it('改写 "we have N years of experience manufacturing engineered wood."', () => {
    const html =
      '<p>At <strong>Shouguang Bailing Wood Industry</strong>, we have 26 years of experience manufacturing engineered wood. Our WBP Plywood meets global standards.</p>';
    const { html: out, hits } = stripExperienceClaims(html);
    expect(hits.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/26 years of experience/);
    expect(out).toContain('we manufacture engineered wood.');
    expect(out).toContain('Our WBP Plywood meets global standards.');
  });

  it('移除 ", with over N years of experience in wood processing," 插入语', () => {
    const html =
      '<p><span>At </span><strong><span>Bailing</span></strong><span> , with over 26 years of experience in wood processing, we offer a wide range of boards.</span></p>';
    const out = stripExperienceClaims(html).html;
    expect(out).not.toMatch(/years of experience/);
    expect(out).toContain('we offer a wide range of boards.');
  });

  it('移除句首 "With over N years of experience, "', () => {
    const html =
      '<p>With over 20 years of experience, <strong>Shandong Bailing Wood Co., Ltd.</strong> operates a 140,000-square-meter facility.</p>';
    const out = stripExperienceClaims(html).html;
    expect(out).not.toMatch(/years of experience/);
    expect(out).toContain('<strong>Shandong Bailing Wood Co., Ltd.</strong> operates');
  });

  it('"With our N-year legacy, we" → "We"', () => {
    const out = stripExperienceClaims('<p>With our 26-year legacy, we combine craftsmanship with technology.</p>').html;
    expect(out).toContain('We combine craftsmanship with technology.');
    expect(out).not.toMatch(/legacy/);
  });

  it('移除签名里的 "(26 years of experience)" 括注', () => {
    const out = stripExperienceClaims('<p><span>Factory: Shouguang City (26 years of experience)</span></p>').html;
    expect(out).not.toMatch(/years of experience/);
    expect(out).toContain('Shouguang City');
  });

  it('整条 li 都是资历声明时移除，保留同列表其它条目', () => {
    const html =
      '<h3>Company Strengths:</h3><ol><li><p>17 years of experience in exporting wood boards; 7 years as Alibaba Gold Supplier.</p></li><li><p>Professional manufacturing expertise.</p></li></ol>';
    const { html: out, hits } = stripExperienceClaims(html);
    expect(hits).toContain('claim-list-item');
    expect(out).not.toMatch(/Alibaba/);
    expect(out).toContain('Professional manufacturing expertise.');
  });

  it('不误伤表格里的数据型年限表述', () => {
    const safe = '<table><thead><tr><th>20-Year Maintenance &amp; Repair Cost</th><th>10-year total ownership cost</th></tr></thead></table>';
    const { html, hits } = stripExperienceClaims(safe);
    expect(hits).toHaveLength(0);
    expect(html).toBe(safe);
  });

  it('幂等', () => {
    const html =
      '<p>At <strong>Bailing</strong>, we have 26 years of experience manufacturing engineered wood. Done.</p>';
    const once = stripExperienceClaims(html).html;
    expect(stripExperienceClaims(once).html).toBe(once);
  });

  it('unwrapExternalCommercialLinks：解包阿里外链、保留文字，不碰其它外链', () => {
    const html =
      '<p>investing in a high-performance<a href="https://bailingwood.en.alibaba.com/"> <strong>waterproof wall cladding</strong></a> system that eliminates rot.</p><p>See <a href="https://bailingwooden.com/">our site</a>.</p>';
    const { html: out, hits } = unwrapExternalCommercialLinks(html);
    expect(hits).toBe(1);
    expect(out).not.toContain('alibaba.com');
    expect(out).toContain('<strong>waterproof wall cladding</strong>');
    expect(out).toContain('href="https://bailingwooden.com/"');
  });

  it('unwrapExternalCommercialLinks：图片型阿里外链整块移除（锚点+三方图+空包裹层）', () => {
    const html =
      '<table><tbody><tr><td>Grade</td></tr></tbody></table><div><div><div><a href="https://bailingwood.en.alibaba.com/" target="_blank" rel="noopener noreferrer"><img src="https://i0.wp.com/sc04.alicdn.com/kf/H29bd0.jpg?w=800&amp;ssl=1"></a></div>';
    const { html: out, hits } = unwrapExternalCommercialLinks(html);
    expect(hits).toBe(1);
    expect(out).not.toContain('alibaba');
    expect(out).not.toContain('alicdn');
    expect(out).toContain('<table><tbody><tr><td>Grade</td></tr></tbody></table>');
    // 空包裹层被收敛，不残留 <div></div>
    expect(out).not.toMatch(/<div[^>]*>\s*<\/div>/i);
  });

  it('unwrapExternalCommercialLinks：无命中时原样返回（保证重存往返恒等）', () => {
    const html = '<p>Text with <a href="https://example.com/">a link</a> and <div> </div> empty-ish div.</p>';
    const { html: out, hits } = unwrapExternalCommercialLinks(html);
    expect(hits).toBe(0);
    expect(out).toBe(html);
  });

  it('hasExperienceClaims 判定', () => {
    expect(hasExperienceClaims('we have 26 years of experience')).toBe(true);
    expect(hasExperienceClaims('a 26-year legacy')).toBe(true);
    expect(hasExperienceClaims('<p>clean</p>')).toBe(false);
  });
});
