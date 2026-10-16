#!/usr/bin/env node
/**
 * Phase 4.8 SEO 自动化验证
 * ---------------------------------------------------------------------------
 * 覆盖任务书：
 *   §十三~十八  各页面动态 metadata / canonical / OG / Twitter Card
 *   §十九      canonical 统一域名（**禁止** localhost / 192.168.x 进入生产 metadata）
 *   §二十~二十二 sitemap 真实读库、不含 Draft/Archived/删除内容；robots 生产 Allow: /
 *   §二十三~二十五 结构化数据 Organization / Product / Article / BreadcrumbList；
 *                **禁止虚构价格 / 库存 / 评分 / 评论**
 *   §十六      Draft 不索引；title/description 中禁止出现 undefined / null
 *
 * 运行：node docs/phase-4.8-seo-verify.mjs
 */

const UI_BASE = 'http://127.0.0.1:3000';
const PROD_HOST = 'bailingwooden.com';

const results = [];
let failures = 0;

function check(id, name, passed, detail = '') {
  results.push({ id, name, passed, detail });
  if (!passed) failures += 1;
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}
const section = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

async function page(path) {
  const res = await fetch(`${UI_BASE}${path}`, { redirect: 'manual' });
  return { status: res.status, html: await res.text() };
}

const attr = (html, re) => {
  const m = html.match(re);
  return m ? m[1] : null;
};

function metas(html) {
  const out = {};
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const name = attr(attrs, /(?:name|property)=["']([^"']+)["']/i);
    const content = attr(attrs, /content=["']([^"']*)["']/i);
    if (name) out[name] = content;
  }
  return out;
}

function links(html) {
  const out = {};
  const re = /<link\s+([^>]+?)\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const rel = attr(attrs, /rel=["']([^"']+)["']/i);
    const href = attr(attrs, /href=["']([^"']*)["']/i);
    if (rel) out[rel] = href;
  }
  return out;
}

function jsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch {
      blocks.push({ __parseError: true, raw: m[1].slice(0, 120) });
    }
  }
  return blocks;
}

const titles = (html) => (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ?? '';

/* -------------------------------------------------------------------------- */

const PAGES = [
  { path: '/', label: '首页' },
  { path: '/about', label: '关于我们' },
  { path: '/factory', label: '工厂实力' },
  { path: '/quality', label: '质量体系' },
  { path: '/applications', label: '应用场景' },
  { path: '/products', label: '产品列表' },
  { path: '/blog', label: '资讯列表' },
  { path: '/contact', label: '联系我们' },
  { path: '/products/demo-wood-panel', label: '产品详情' },
];

async function main() {
  console.log('Phase 4.8 SEO 自动化验证');
  console.log(`UI=${UI_BASE}`);

  /* ------------------------------------------------------------------ */
  section('Part 1 · 每页 metadata / canonical / OG / Twitter（§十三~§十九）');
  /* ------------------------------------------------------------------ */

  for (const { path, label } of PAGES) {
    const { status, html } = await page(path);
    const t = titles(html);
    const m = metas(html);
    const l = links(html);

    check(`${path} 可访问`, `${label} 返回 200`, status === 200, `HTTP ${status}`);

    // title
    const titleOk = t.trim().length > 0 && !/undefined|null/i.test(t);
    check(`${path} title`, `${label} title 非空且无 undefined/null`, titleOk, t.slice(0, 90));

    // description
    const desc = m['description'] ?? '';
    check(
      `${path} desc`,
      `${label} description 非空且无 undefined/null`,
      desc.trim().length > 0 && !/undefined|null/i.test(desc),
      desc.slice(0, 70),
    );

    // canonical
    const canonical = l.canonical ?? '';
    const canonicalOk =
      canonical.startsWith('https://') &&
      canonical.includes(PROD_HOST) &&
      !/localhost|127\.0\.0\.1|192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\./i.test(canonical);
    check(`${path} canonical`, `${label} canonical 为生产域名且非私网`, canonicalOk, canonical);

    // og:*
    const ogOk =
      !!m['og:title'] &&
      !!m['og:description'] &&
      !!m['og:url'] &&
      !!m['og:image'] &&
      !!m['og:type'] &&
      !!m['og:site_name'];
    check(
      `${path} og`,
      `${label} Open Graph 完整（title/desc/url/image/type/site_name）`,
      ogOk,
      `type=${m['og:type']} url=${(m['og:url'] ?? '').slice(0, 48)}`,
    );
    check(
      `${path} og:url`,
      `${label} og:url 为生产域名`,
      (m['og:url'] ?? '').includes(PROD_HOST) && !/localhost|192\.168\./.test(m['og:url'] ?? ''),
      m['og:url'] ?? '',
    );

    // twitter
    const twOk = m['twitter:card'] === 'summary' && !!m['twitter:title'] && !!m['twitter:image'];
    check(`${path} twitter`, `${label} Twitter Card 完整`, twOk, `card=${m['twitter:card']}`);

    // robots
    const robots = m['robots'] ?? '';
    check(
      `${path} robots`,
      `${label} robots 允许索引（生产）`,
      /index/.test(robots) && !/noindex/.test(robots),
      robots || '(未输出)',
    );
  }

  /* ------------------------------------------------------------------ */
  section('Part 2 · 结构化数据（§二十三~§二十五）');
  /* ------------------------------------------------------------------ */

  {
    const home = await page('/');
    const blocks = jsonLd(home.html);
    const org = blocks.find((b) => b['@type'] === 'Organization');
    check('jsonld.home', '首页输出 Organization 结构化数据', !!org, org ? org.name : '缺失');

    const prod = await page('/products/demo-wood-panel');
    const pblocks = jsonLd(prod.html);
    const product = pblocks.find((b) => b['@type'] === 'Product');
    check('jsonld.product', '产品详情输出 Product 结构化数据', !!product, product?.name ?? '缺失');

    // 禁止虚构价格 / 库存 / 评分 / 评论
    const flat = JSON.stringify(pblocks);
    const forbidden = ['offers', 'priceCurrency', 'price', 'aggregateRating', 'ratingValue', 'review', 'reviewCount', 'availability'];
    const hits = forbidden.filter((k) => new RegExp(`"${k}"`, 'i').test(flat));
    check(
      'jsonld.nofake',
      'Product 未包含虚构的价格/库存/评分/评论',
      hits.length === 0,
      hits.length ? `发现: ${hits.join(', ')}` : '无',
    );

    // BreadcrumbList
    const breadcrumb = pblocks.find((b) => b['@type'] === 'BreadcrumbList');
    check(
      'jsonld.breadcrumb',
      '详情页输出 BreadcrumbList',
      !!breadcrumb && Array.isArray(breadcrumb.itemListElement) && breadcrumb.itemListElement.length >= 2,
      breadcrumb ? `${breadcrumb.itemListElement.length} 层` : '缺失',
    );

    // JSON-LD 必须可解析（无注入破坏）
    const bad = pblocks.filter((b) => b.__parseError);
    check('jsonld.parse', '全部 JSON-LD 可被解析', bad.length === 0, `${pblocks.length} 块`);
  }

  /* ------------------------------------------------------------------ */
  section('Part 3 · sitemap.xml / robots.txt（§二十~§二十二）');
  /* ------------------------------------------------------------------ */

  {
    const res = await fetch(`${UI_BASE}/sitemap.xml`);
    const xml = await res.text();
    check('sitemap.status', 'sitemap.xml 可访问', res.status === 200, `HTTP ${res.status}`);

    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    check('sitemap.count', 'sitemap 含站点路由', locs.length > 0, `${locs.length} 条`);

    const allProdHost = locs.every((u) => u.includes(PROD_HOST));
    check('sitemap.host', 'sitemap 全部使用生产域名', allProdHost, locs[0] ?? '');

    const noLocal = !locs.some((u) => /localhost|192\.168\.|127\.0\.0\.1/.test(u));
    check('sitemap.nolocal', 'sitemap 不含本机/私网地址', noLocal);

    // 含已发布产品详情
    const hasDemo = locs.some((u) => u.includes('/products/demo-wood-panel'));
    check('sitemap.published', 'sitemap 含已发布产品详情', hasDemo);

    // 不含 DRAFT 内容（playwright-oak-* 均为 DRAFT）
    const hasDraft = locs.some((u) => /playwright-oak/.test(u));
    check('sitemap.nodraft', 'sitemap 不含 Draft 内容', !hasDraft);

    // 不含 design-system（内部预览页）
    check('sitemap.nopreview', 'sitemap 不含内部预览页 /design-system', !locs.some((u) => u.includes('design-system')));
  }

  {
    const res = await fetch(`${UI_BASE}/robots.txt`);
    const txt = await res.text();
    check('robots.status', 'robots.txt 可访问', res.status === 200, `HTTP ${res.status}`);

    const allowsAll = /Allow:\s*\/\s*$/m.test(txt) || /Allow:\s*\/\s*\n/.test(txt);
    check('robots.allow', 'robots 生产环境 Allow: /（不误封整站）', allowsAll, txt.replace(/\n/g, ' | ').slice(0, 120));

    const noDisallowAll = !/Disallow:\s*\/\s*$/m.test(txt.replace(/Disallow:\s*\/api\/[\s\S]*/, ''));
    check('robots.notblocked', 'robots 未整站 Disallow: /', noDisallowAll);

    check('robots.sitemap', 'robots 指向 sitemap', /Sitemap:/i.test(txt), (txt.match(/Sitemap:\s*\S+/) || [''])[0]);
  }

  /* ------------------------------------------------------------------ */
  section('Part 4 · 不存在内容不得索引（§十六 / §三十一）');
  /* ------------------------------------------------------------------ */

  {
    const { status, html } = await page('/products/definitely-not-exist');
    check('404.status', '不存在的产品返回真实 404', status === 404, `HTTP ${status}`);
    const m = metas(html);
    const robots = m['robots'] ?? '';
    check('404.noindex', '404 页面标记 noindex', /noindex/i.test(robots), robots || '(未输出)');
  }

  /* ------------------------------------------------------------------ */
  section('汇总');
  /* ------------------------------------------------------------------ */

  const passed = results.length - failures;
  console.log(`总计 ${results.length} 项断言，通过 ${passed}，失败 ${failures}`);
  if (failures) {
    console.log('\n失败项：');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.id} ${r.name} :: ${r.detail}`));
  }
  console.log(failures === 0 ? '\n✓ 全部通过' : '\n✗ 存在失败项');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
