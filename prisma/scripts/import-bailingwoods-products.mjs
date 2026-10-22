/**
 * 从 http://www.bailingwoods.com（第二旧站）迁移产品到新站 —— 走 CMS API
 *
 * 背景：该站 15 个产品全部是「标题 + 图片集」，正文无任何文字；4 篇 news 为空壳
 * 公司文化页（已确认跳过）。经与新站现有 34 个产品查重，仅 5 个为真正新增，
 * 本次只迁这 5 个：
 *   Pine Plywood / Teak Plywood / Okoume Plywood / Ash Veneer MDF / Particle Board / Chipboard
 *
 * 正文策略（按用户指示）：复制同品类现有产品的正文作为文案基底，替换产品名，
 * 顶部补一句由产品名可推出的事实性描述；产品图片从旧站下载后回传新站媒体库，
 * 以 <img> 形式追加在正文末尾。全部以 DRAFT 创建，供人工复核后上架。
 *
 * 用法：
 *   node prisma/scripts/import-bailingwoods-products.mjs            # dry-run（默认，不写库）
 *   node prisma/scripts/import-bailingwoods-products.mjs --apply    # 执行上传与创建
 *
 * 幂等：slug 已存在则跳过；媒体按原文件名+产品 slug 去重（同一次运行内缓存）。
 */
import { execFileSync } from 'node:child_process';

const API = process.env.API_BASE ?? 'http://localhost:4000/api/v1';
const SITE = 'http://www.bailingwoods.com/en/';
const ORIGIN = 'http://www.bailingwoods.com/';
const APPLY = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const JOBS = [
  {
    url: 'product_detail-19-35-14.html',
    name: 'Pine Plywood',
    slug: 'pine-plywood',
    categorySlug: 'plywood',
    templateSlug: 'commercial-plywood',
    factual: 'Plywood manufactured with pine veneer faces.',
  },
  {
    url: 'product_detail-19-35-17.html',
    name: 'Teak Plywood',
    slug: 'teak-plywood',
    categorySlug: 'plywood',
    templateSlug: 'commercial-plywood',
    factual: 'Plywood faced with teak veneer.',
  },
  {
    url: 'product_detail-19-35-18.html',
    name: 'Okoume Plywood',
    slug: 'okoume-plywood',
    categorySlug: 'plywood',
    templateSlug: 'commercial-plywood',
    factual: 'Plywood faced with okoume veneer.',
  },
  {
    url: 'product_detail-30-35-21.html',
    name: 'Ash Veneer MDF',
    slug: 'ash-veneer-mdf',
    categorySlug: 'mdf',
    templateSlug: 'plain-mdf',
    factual: 'MDF board faced with ash wood veneer.',
  },
  {
    url: 'product_detail-36-35-24.html',
    name: 'Particle Board / Chipboard',
    slug: 'particle-board-chipboard',
    categorySlug: 'particle-board',
    templateSlug: 'melamine-particle-board',
    factual: 'Standard particle board (chipboard) panel.',
  },
];

function psqlJson(sql) {
  const out = execFileSync(
    'docker',
    ['exec', '-i', 'bailing-postgres', 'psql', '-U', 'bailing', '-d', 'bailingwooden', '-t', '-A', '-c', sql],
    { maxBuffer: 32 * 1024 * 1024 },
  ).toString('utf8');
  const text = out.trim();
  return text ? JSON.parse(text) : [];
}

async function login() {
  const email = process.env.ADMIN_EMAIL ?? 'admin@bailingwooden.com';
  const password =
    process.env.ADMIN_PASSWORD ??
    execFileSync('bash', ['-lc', "grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-"], {
      cwd: new URL('../../', import.meta.url).pathname.replace(/^\//, ''),
    })
      .toString()
      .trim();
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  const token = json?.data?.accessToken ?? json?.accessToken;
  if (!token) throw new Error(`登录失败: ${JSON.stringify(json).slice(0, 300)}`);
  return token;
}

function absUrl(src) {
  if (/^https?:\/\//i.test(src)) return src;
  // 根相对路径（/uploadfile/...）必须按域名解析，不能拼到 /en/ 下
  if (src.startsWith('/')) return new URL(src, ORIGIN).href;
  return new URL(src, SITE).href;
}

function parseProduct(html) {
  const titleTag = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const start = html.search(/<div class="lc-txt/i);
  if (start < 0) throw new Error('未找到正文容器 div.lc-txt');
  const end = html.indexOf('</section>', start);
  const block = html.slice(start, end > 0 ? end : start + 20000);
  const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block)?.[1] ?? '';
  const name = h3.replace(/<[^>]+>/g, '').trim();
  const imgs = [...block.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => absUrl(m[1]));
  return { titleTag, name, imgs: [...new Set(imgs)] };
}

function buildDescription({ name, factual, templateName, templateBody, imageUrls }) {
  const heading = `<p><strong>${name}</strong> — ${factual}</p>`;
  let body = templateBody;
  if (templateName && templateName !== name) {
    body = body.replace(new RegExp(templateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), name);
  }
  const gallery = imageUrls
    .map((u) => `<p><img src="${u}" alt="${name}" loading="lazy"></p>`)
    .join('\n');
  return `${heading}\n${body}\n${gallery}`;
}

async function uploadImage(token, url, nameHint) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`下载图片失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (url.split('.').pop() ?? 'jpg').toLowerCase().split('?')[0];
  const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const fileName = `${nameHint}-${url.split('/').pop()}`;
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), fileName);
  const up = await fetch(`${API}/cms/media/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await up.json();
  if (!up.ok) throw new Error(`上传失败 ${up.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json?.data?.url ?? json?.url;
}

async function main() {
  console.log(`模式：${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（不写库）'}\n`);

  const categories = psqlJson(
    `SELECT json_agg(ROW_TO_JSON(t)) FROM (SELECT id, slug FROM categories) t`,
  );
  const catBySlug = new Map(categories.map((c) => [c.slug, c.id]));
  const existingSlugs = new Set(
    psqlJson(`SELECT json_agg(ROW_TO_JSON(t)) FROM (SELECT slug FROM products) t`).map((r) => r.slug),
  );
  const templates = new Map(
    psqlJson(
      `SELECT json_agg(ROW_TO_JSON(t)) FROM (SELECT slug, name, description FROM products WHERE slug IN ('commercial-plywood','plain-mdf','melamine-particle-board')) t`,
    ).map((r) => [r.slug, r]),
  );

  const token = APPLY ? await login() : null;
  const results = [];

  for (const job of JOBS) {
    const item = { name: job.name, slug: job.slug, template: job.templateSlug };
    try {
      if (existingSlugs.has(job.slug)) {
        item.status = 'skipped-exists';
        results.push(item);
        continue;
      }
      const categoryId = catBySlug.get(job.categorySlug);
      if (!categoryId) throw new Error(`分类不存在: ${job.categorySlug}`);
      const template = templates.get(job.templateSlug);
      if (!template) throw new Error(`模板产品不存在: ${job.templateSlug}`);

      const res = await fetch(SITE + job.url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`抓取失败 ${res.status}`);
      const parsed = parseProduct(await res.text());
      item.sourceName = parsed.name;
      item.images = parsed.imgs.length;
      item.titleTag = parsed.titleTag;

      if (!APPLY) {
        const preview = buildDescription({
          name: job.name,
          factual: job.factual,
          templateName: template.name,
          templateBody: template.description,
          imageUrls: parsed.imgs,
        });
        item.plannedDescriptionLen = preview.length;
        item.status = 'planned';
        results.push(item);
        continue;
      }

      const mediaUrls = [];
      for (const img of parsed.imgs) {
        mediaUrls.push(await uploadImage(token, img, job.slug));
      }
      item.uploaded = mediaUrls.length;

      const description = buildDescription({
        name: job.name,
        factual: job.factual,
        templateName: template.name,
        templateBody: template.description,
        imageUrls: mediaUrls,
      });
      const shortDescription = `${job.name} — ${job.factual}`.slice(0, 100);

      const create = await fetch(`${API}/cms/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: job.name,
          slug: job.slug,
          categoryId,
          description,
          shortDescription,
        }),
      });
      const created = await create.json();
      if (!create.ok) throw new Error(`创建失败 ${create.status}: ${JSON.stringify(created).slice(0, 300)}`);
      item.status = 'created';
      item.id = created?.data?.id ?? created?.id;
      results.push(item);
    } catch (error) {
      item.status = 'error';
      item.error = String(error.message ?? error).slice(0, 300);
      results.push(item);
    }
  }

  console.log(JSON.stringify(results, null, 2));
  const bad = results.filter((r) => r.status === 'error');
  process.exit(bad.length ? 1 : 0);
}

await main();
