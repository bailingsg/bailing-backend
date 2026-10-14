#!/bin/bash
# Phase 4.3 Admin Media Library 浏览器全流程验证（playwright-cli，单会话）
# 覆盖：登录 → Media 页 → 拖拽上传 → 画廊卡片 → 预览弹窗 → 两步确认删除
set -u
PCLI="C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/.bin/playwright-cli.cmd"
cd /d/com.bailingwooden/bailing-admin || exit 1
RUN=$(date +%s)
ORIGINAL="pw-media-${RUN}.png"
PNG="C:/Users/Administrator/AppData/Local/Temp/${ORIGINAL}"
SHOT="C:/Users/Administrator/AppData/Local/Temp/pw-media-${RUN}.png.png"

# 合法可解码 PNG（640×480 RGB，含 IHDR/IDAT/IEND 与 CRC）——
# 必须能被浏览器解码，否则 <img> 触发 onerror（curl 不校验内容，会误判为正常）
node -e "
const fs = require('fs');
const zlib = require('zlib');
const t = (() => { const a = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; a[n] = c >>> 0; } return a; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const W = 640, H = 480;
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc(H * (1 + W * 3), 0);
const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(process.argv[1], png);
" "$PNG" || exit 1

info() { echo "== $* =="; }
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; }

# 专用测试管理员（不触碰真实账号；真实账号密码由用户自行管理）
PW_EMAIL="pw-media@bailingwooden.test"
PW_PASSWORD="Pw-Media-2026!"

# 预清理：历史 pw-media 资产（数据库行 + 磁盘文件）
docker exec bailing-postgres psql -U bailing -d bailingwooden -t -A -c "SELECT \"storageKey\" FROM media_assets WHERE \"originalName\" LIKE 'pw-media-%';" 2>/dev/null | while read -r KEY; do
  [ -n "$KEY" ] && rm -f "/d/com.bailingwooden/bailing-backend/uploads/media/${KEY#media/}" 2>/dev/null
done
docker exec bailing-postgres psql -U bailing -d bailingwooden -c "DELETE FROM media_assets WHERE \"originalName\" LIKE 'pw-media-%';" >/dev/null 2>&1

# eval 结果解析：### Result 的下一行
evalstr() { "$PCLI" eval "() => $1" 2>/dev/null | awk '/### Result/{getline; print; exit}' | tr -d '"' | tr -d '\r'; }
wait_text() { # $1=期望文本 $2=最多秒数
  for _ in $(seq 1 "$2"); do
    TXT=$(evalstr "document.querySelector('main')?.innerText ?? ''")
    case "$TXT" in *"$1"*) return 0 ;; esac
    sleep 1
  done
  return 1
}

info "1. 登录"
"$PCLI" open http://127.0.0.1:3001/login >/dev/null 2>&1
sleep 2
"$PCLI" fill "#email" "$PW_EMAIL" >/dev/null 2>&1
"$PCLI" fill "#password" "$PW_PASSWORD" >/dev/null 2>&1
"$PCLI" click "button[type=submit]" >/dev/null 2>&1
for _ in $(seq 1 15); do
  U=$(evalstr "location.pathname")
  [ "$U" = "/dashboard" ] && break
  sleep 1
done
[ "$U" = "/dashboard" ] && pass "登录成功进入 /dashboard" || fail "登录后 URL: $U"

info "2. 进入媒体资源库"
"$PCLI" goto http://127.0.0.1:3001/media >/dev/null 2>&1
sleep 3
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "媒体资源库" && pass "/media 页面渲染成功" || fail "/media 页面异常: $TXT"

info "3. 拖拽上传（drop 事件）"
"$PCLI" drop '[aria-label^="上传图片"]' --path "$PNG" >/dev/null 2>&1
if wait_text "$ORIGINAL" 20; then
  pass "拖拽上传成功，画廊出现媒体卡片：$ORIGINAL"
else
  fail "拖拽上传后画廊未见卡片"
  TXT=$(evalstr "document.querySelector('main').innerText")
  echo "INFO  页面文本: $(echo "$TXT" | head -c 300)"
fi
sleep 1
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "上传成功" && echo "INFO  「上传成功」提示可见" || echo "INFO  「上传成功」提示未持续显示（refresh 后卸载，属正常）"

info "4. 画廊卡片校验（缩略图/文件名/类型/大小/尺寸/时间）"
if wait_text "$ORIGINAL" 5; then
  pass "画廊出现上传的媒体卡片：$ORIGINAL"
else
  fail "画廊未见上传卡片"
fi
# 证据：同一 URL 的 curl 状态（用于区分「服务端不可达」与「图片不可解码」）
SRC=$(evalstr "(() => { const imgs = Array.from(document.querySelectorAll('img')); const hit = imgs.find(i => (i.getAttribute('alt')||'').includes('${ORIGINAL}')); return hit ? hit.getAttribute('src') : 'noimg'; })()")
if [ "$SRC" != "noimg" ]; then
  echo "INFO   媒体 URL: $SRC"
  echo "INFO   同一 URL 的 curl: $(curl -s --noproxy '*' -o /dev/null -w '%{http_code} %{size_download}B %{content_type}' "$SRC")"
fi
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "PNG" && pass "卡片显示类型 PNG" || fail "卡片缺类型标签"
echo "$TXT" | grep -q "640×480" && pass "卡片显示尺寸 640×480" || fail "卡片缺尺寸信息"
IMG=""
evalstr "(() => { const imgs = Array.from(document.querySelectorAll('img')); const hit = imgs.find(i => (i.getAttribute('alt')||'').includes('${ORIGINAL}')); if (hit) hit.scrollIntoView({block: 'center'}); return 'ok'; })()" >/dev/null 2>&1
for _ in $(seq 1 10); do
  IMG=$(evalstr "(() => { const imgs = Array.from(document.querySelectorAll('img')); const hit = imgs.find(i => (i.getAttribute('alt')||'').includes('${ORIGINAL}')); return hit ? (hit.complete && hit.naturalWidth ? hit.naturalWidth + 'x' + hit.naturalHeight : 'loading') : 'noimg'; })()")
  [ "$IMG" = "640x480" ] && break
  sleep 1
done
[ "$IMG" = "640x480" ] && pass "缩略图真实加载并可访问（naturalWidth 640）" || fail "缩略图加载异常: $IMG"

info "5. 截图留档"
SHOT_OUT=$("$PCLI" screenshot 2>&1 | tr -d '\r')
echo "$SHOT_OUT" | tail -3

info "6. 图片预览弹窗"
"$PCLI" click 'button[aria-label^="预览"]' >/dev/null 2>&1
sleep 2
DLG=$(evalstr "(() => { const d = document.querySelector('[role=dialog]'); return d ? d.innerText.slice(0,200) : 'nodialog'; })()")
echo "$DLG" | grep -q "存储键" && pass "预览弹窗打开（含存储键等元数据）" || fail "预览弹窗异常: $DLG"
"$PCLI" click 'button:has-text("关闭")' >/dev/null 2>&1
sleep 1
DLG2=$(evalstr "(() => { const d = document.querySelector('[role=dialog]'); return d ? 'open' : 'closed'; })()")
[ "$DLG2" = "closed" ] && pass "预览弹窗已关闭" || fail "预览弹窗未关闭"

info "7. 两步确认删除"
"$PCLI" eval "(() => { const cards = Array.from(document.querySelectorAll('li')); const card = cards.find(li => li.innerText.includes('${ORIGINAL}')); if (!card) return 'nocard'; const btn = Array.from(card.querySelectorAll('button')).find(b => b.innerText.trim() === '删除'); if (!btn) return 'nobtn'; btn.click(); return 'clicked'; })()" >/dev/null 2>&1
sleep 1
"$PCLI" eval "(() => { const cards = Array.from(document.querySelectorAll('li')); const card = cards.find(li => li.innerText.includes('${ORIGINAL}')); if (!card) return 'nocard'; const btn = Array.from(card.querySelectorAll('button')).find(b => b.innerText.trim() === '确认删除'); if (!btn) return 'nobtn'; btn.click(); return 'confirm'; })()" >/dev/null 2>&1
if wait_text "$ORIGINAL" 3; then
  # 卡片可能仍在（等待刷新）→ 再等一轮反向断言
  sleep 3
  TXT=$(evalstr "document.querySelector('main').innerText")
  echo "$TXT" | grep -q "$ORIGINAL" && fail "删除后卡片仍在" || pass "两步删除成功，卡片已消失"
else
  pass "两步删除成功，卡片已消失"
fi

info "8. 删除后后端数据库与磁盘校验（经 API 层由 e2e 已覆盖，这里确认列表计数）"
TOTAL=$(evalstr "document.querySelector('main').innerText.match(/共\s*(\d+)\s*个媒体/)?.[1] ?? 'unknown'")
echo "INFO  当前媒体总数: $TOTAL"

"$PCLI" close >/dev/null 2>&1
rm -f "$PNG"

# 末清理：删除媒体资产行与磁盘文件（测试账号保留，供复用）
docker exec bailing-postgres psql -U bailing -d bailingwooden -t -A -c "SELECT \"storageKey\" FROM media_assets WHERE \"originalName\" LIKE 'pw-media-%';" 2>/dev/null | while read -r KEY; do
  [ -n "$KEY" ] && rm -f "/d/com.bailingwooden/bailing-backend/uploads/media/${KEY#media/}" 2>/dev/null
done
docker exec bailing-postgres psql -U bailing -d bailingwooden -c "DELETE FROM media_assets WHERE \"originalName\" LIKE 'pw-media-%';" >/dev/null 2>&1

echo ""
echo "===== Phase 4.3 媒体库浏览器流程结束 ====="
