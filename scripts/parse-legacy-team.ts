/**
 * 解析旧站 https://bailingwooden.com/contact-us/ 的「Meet the Expert Team」区块。
 *
 * 输出：docs/migration/legacy-raw/legacy-team-contacts.json
 *
 * 说明：
 *   · 邮箱被 Cloudflare Email Protection 包裹（a.__cf_email__ 的 data-cfemail 十六进制）
 *     → 用 CF 公开的解码算法还原：首字节为 key，其余每字节与 key 异或
 *   · 电话按卡片内 contact-info 文本顺序取，第 1 个为 WhatsApp，第 2 个为备用手机
 *     （旧站两个图标分别是 WhatsApp 与电话，实际展示的是同一/两个号码）
 *   · 姓名在 team-two__author__item__social 的 <a> 文本里
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'docs/migration/legacy-raw/contact-us-live.html';
const OUT = 'docs/migration/legacy-raw/legacy-team-contacts.json';

const html = readFileSync(SRC, 'utf8');

/** Cloudflare email-protection 解码 */
function decodeCfEmail(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

interface Member {
  index: number;
  name: string;
  photoUrl: string;
  photoAlt: string;
  phones: string[];
  whatsapp: string | null;
  altPhone: string | null;
  email: string | null;
}

const members: Member[] = [];

// 逐卡片切分：<div id="team_N" ...> ... </div>（到下一个 team_N 或区块结束）
const cardRe = /<div id="team_(\d+)" class="team-two__author__item">([\s\S]*?)(?=<div id="team_\d+" class="team-two__author__item">|<\/div>\s*<\/div>\s*<\/section>)/g;

let m: RegExpExecArray | null;
while ((m = cardRe.exec(html)) !== null) {
  const index = Number(m[1]);
  const body = m[2];

  const imgMatch = /<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/i.exec(body);
  const photoUrl = imgMatch?.[1] ?? '';
  const photoAlt = imgMatch?.[2] ?? '';

  // contact-info 区块文本 → 电话
  const infoMatch = /<div class="contact-info">([\s\S]*?)<\/div>/.exec(body);
  const infoHtml = infoMatch?.[1] ?? '';
  const infoText = infoHtml
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ');
  const phones = [
    ...new Set(
      (infoText.match(/\+\d{7,15}/g) ?? []).map((p) => p.trim()),
    ),
  ];

  const cfHex = /data-cfemail="([0-9a-fA-F]+)"/.exec(infoHtml)?.[1];
  const email = cfHex ? decodeCfEmail(cfHex) : null;

  const nameMatch = /team-two__author__item__social">[\s\S]*?<a[^>]*>([^<]+)<\/a>/i.exec(body);
  const name = (nameMatch?.[1] ?? '').trim();

  if (!name) continue;

  members.push({
    index,
    name,
    photoUrl,
    photoAlt,
    phones,
    whatsapp: phones[0] ?? null,
    altPhone: phones[1] ?? null,
    email,
  });
}

writeFileSync(OUT, JSON.stringify(members, null, 2) + '\n', 'utf8');

console.log(`解析到 ${members.length} 位员工\n`);
for (const p of members) {
  console.log(
    `${String(p.index).padStart(2)}. ${p.name.padEnd(14)} wa=${(p.whatsapp ?? '-').padEnd(15)} tel2=${(p.altPhone ?? '-').padEnd(15)} ${p.email ?? '-'}`,
  );
}
