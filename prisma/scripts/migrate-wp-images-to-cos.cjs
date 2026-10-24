/**
 * i0.wp.com 外链图片 → COS 迁移（Jetpack Photon 热链治理）
 *
 * 背景：Phase 5.4 迁移只本地化了旧站自有媒体；正文里还有一批建站时期从
 * 第三方站点（阿里 CDN / 同行官网）拷贝、经 WordPress Jetpack Photon
 * （i0.wp.com）代理热链的图片，共 20 张，分布在 4 篇博客 + 13 个产品。
 * 风险：图片可用性完全不受我们控制（Photon 限流/关停即全站破图），
 * 且拖慢首屏、不利于 SEO 图片收录。
 *
 * 本脚本只做「下载 → 上传 COS → 产出 URL 映射」三件事，**不碰数据库**：
 *   1. 输入：URL 清单文件（每行一条库里原始存储形态的 URL，含 &amp; 实体）
 *   2. 下载（带重试；Photon 失败时回退直连源站），按 Content-Type 定扩展名
 *   3. 上传 COS，key = media/<年>/<月>/wp-<sha1(url)[:16]>.<ext>（确定性 → 幂等）
 *   4. 输出 mapping.json：{ 库中原始URL: { newUrl, key, size, mimeType, ... } }
 *
 * 数据库回写由调用方用 mapping.json 生成 SQL 执行（可人工复核后再执行）。
 *
 * 用法：
 *   node prisma/scripts/migrate-wp-images-to-cos.cjs <url-list.txt> <mapping-out.json>
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const crypto = require('crypto');
const COS = require('cos-nodejs-sdk-v5');

const CDN = (process.env.COS_CDN_DOMAIN || '').replace(/\/$/, '');
const BUCKET = process.env.TENCENT_COS_BUCKET;
const REGION = process.env.TENCENT_COS_REGION;

if (!CDN || !BUCKET || !REGION) {
  console.error('缺少 COS_CDN_DOMAIN / TENCENT_COS_BUCKET / TENCENT_COS_REGION');
  process.exit(1);
}

const cos = new COS({
  SecretId: process.env.TENCENT_COS_SECRET_ID,
  SecretKey: process.env.TENCENT_COS_SECRET_KEY,
});

const putObject = (params) =>
  new Promise((resolve, reject) => cos.putObject(params, (err, data) => (err ? reject(err) : resolve(data))));
const headObject = (Key) =>
  new Promise((resolve) => cos.headObject({ Bucket: BUCKET, Region: REGION, Key }, (err, data) => resolve(err ? null : data)));

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

/** HTML 实体解码：库里存的是 src 属性里的形态，&amp; 需还原成 & 才能下载 */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 从 URL 路径猜扩展名（兼容 POST-05402.png.webp 这类双扩展名） */
function extFromPath(pathname) {
  const base = pathname.split('/').pop() || '';
  const m = /\.([A-Za-z0-9]+)$/.exec(base);
  return m ? `.${m[1].toLowerCase()}` : '';
}

async function download(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error(`响应过小(${buf.length}B)，疑似错误页`);
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      return { buf, contentType: ct };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

(async () => {
  const [listPath, outPath] = process.argv.slice(2);
  if (!listPath || !outPath) {
    console.error('用法: node migrate-wp-images-to-cos.cjs <url-list.txt> <mapping-out.json>');
    process.exit(1);
  }

  const rawUrls = fs
    .readFileSync(listPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const urls = [...new Set(rawUrls)];
  console.log(`输入 ${rawUrls.length} 条，去重后 ${urls.length} 个 distinct URL`);

  const now = new Date();
  const ym = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;

  const mapping = {};
  const failed = [];

  for (const stored of urls) {
    const fetchUrl = decodeEntities(stored);
    const hash = crypto.createHash('sha1').update(fetchUrl).digest('hex').slice(0, 16);
    let dl;
    try {
      dl = await download(fetchUrl);
    } catch (e) {
      // Photon 失败 → 回退直连源站（去掉 i0.wp.com 前缀即是原始地址）
      const origin = fetchUrl.replace(/^https?:\/\/i\d\.wp\.com\//, 'https://');
      if (origin !== fetchUrl) {
        try {
          dl = await download(origin);
        } catch (e2) {
          failed.push({ stored, reason: `Photon: ${e.message} / 源站: ${e2.message}` });
          continue;
        }
      } else {
        failed.push({ stored, reason: e.message });
        continue;
      }
    }

    const ext = MIME_EXT[dl.contentType] || extFromPath(new URL(fetchUrl).pathname) || '.jpg';
    const key = `media/${ym}/wp-${hash}${ext}`;
    const newUrl = `${CDN}/${key}`;

    const existing = await headObject(key);
    if (existing) {
      console.log(`  已存在，跳过上传: ${key}`);
    } else {
      await putObject({
        Bucket: BUCKET,
        Region: REGION,
        Key: key,
        Body: dl.buf,
        ContentType: dl.contentType || MIME_EXT[ext] || 'application/octet-stream',
        CacheControl: 'public, max-age=604800',
      });
      console.log(`  已上传: ${key}  ${(dl.buf.length / 1024).toFixed(1)}KB ${dl.contentType}`);
    }

    const base = decodeURIComponent(new URL(fetchUrl).pathname.split('/').pop() || 'image');
    mapping[stored] = {
      newUrl,
      key,
      size: dl.buf.length,
      mimeType: dl.contentType || MIME_EXT[ext] || 'application/octet-stream',
      originalName: base,
    };
  }

  fs.writeFileSync(outPath, JSON.stringify(mapping, null, 2));
  console.log(`\n完成: ${Object.keys(mapping).length} 个映射 → ${outPath}`);
  if (failed.length) {
    console.log(`失败 ${failed.length} 个:`);
    failed.forEach((f) => console.log(`  ${f.reason}\n    ${f.stored}`));
    process.exit(2);
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
