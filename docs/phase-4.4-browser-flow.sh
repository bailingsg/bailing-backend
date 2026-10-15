#!/bin/bash
# Phase 4.4 Blog CMS 浏览器全流程验证（playwright-cli，单会话）
# 覆盖：登录 → 分类管理 → 标签管理 → 新建文章（富文本 + SEO）→ 编辑页 SEO 校验
#       → 媒体库上传 → 选择封面 → 列表校验 → 引用检查（封面保护）→ 两步删除
set -u
PCLI="C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/.bin/playwright-cli.cmd"
cd /d/com.bailingwooden/bailing-admin || exit 1
RUN=$(date +%s)
CAT_NAME="行业资讯-${RUN}"
CAT_SLUG="pw-blog-cat-${RUN}"
TAG_NAME="出口-${RUN}"
TAG_SLUG="pw-blog-tag-${RUN}"
POST_TITLE="板材出口指南 ${RUN}"
POST_SLUG="pw-blog-post-${RUN}"
ORIGINAL="pw-blog-cover-${RUN}.png"
PNG="C:/Users/Administrator/AppData/Local/Temp/${ORIGINAL}"

# 合法可解码 PNG（640×480 RGB，含 IHDR/IDAT/IEND 与 CRC）——
# 必须能被浏览器解码，否则 <img> 触发 onerror
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

# 专用测试管理员（不触碰真实账号）
PW_EMAIL="pw-blog@bailingwooden.test"
PW_PASSWORD="Pw-Blog-2026!"

# 预清理：历史 pw-blog 数据（数据库行 + 磁盘文件）
cleanup_test_data() {
  docker exec bailing-postgres psql -U bailing -d bailingwooden -t -A -c "SELECT \"storageKey\" FROM media_assets WHERE \"originalName\" LIKE 'pw-blog-%';" 2>/dev/null | while read -r KEY; do
    [ -n "$KEY" ] && rm -f "/d/com.bailingwooden/bailing-backend/uploads/media/${KEY#media/}" 2>/dev/null
  done
  docker exec bailing-postgres psql -U bailing -d bailingwooden -c "DELETE FROM blog_posts WHERE slug LIKE 'pw-blog-%';" >/dev/null 2>&1
  docker exec bailing-postgres psql -U bailing -d bailingwooden -c "DELETE FROM blog_categories WHERE slug LIKE 'pw-blog-%';" >/dev/null 2>&1
  docker exec bailing-postgres psql -U bailing -d bailingwooden -c "DELETE FROM blog_tags WHERE slug LIKE 'pw-blog-%';" >/dev/null 2>&1
  docker exec bailing-postgres psql -U bailing -d bailingwooden -c "DELETE FROM media_assets WHERE \"originalName\" LIKE 'pw-blog-%';" >/dev/null 2>&1
}
cleanup_test_data

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
U=""
for _ in $(seq 1 15); do
  U=$(evalstr "location.pathname")
  [ "$U" = "/dashboard" ] && break
  sleep 1
done
[ "$U" = "/dashboard" ] && pass "登录成功进入 /dashboard" || fail "登录后 URL: $U"

info "2. 博客管理入口（侧边栏可点击，非 Coming Soon）"
"$PCLI" goto http://127.0.0.1:3001/dashboard >/dev/null 2>&1
sleep 2
LINK=$(evalstr "(() => { const a = Array.from(document.querySelectorAll('aside a')).find(x => x.getAttribute('href') === '/blog'); return a ? a.innerText.replace(/\s+/g,' ').trim() : 'nolink'; })()")
echo "$LINK" | grep -q "博客管理" && pass "侧边栏 Blog 项可用（提示：$LINK）" || fail "侧边栏 Blog 项异常: $LINK"

info "3. 文章列表页"
"$PCLI" goto http://127.0.0.1:3001/blog >/dev/null 2>&1
sleep 3
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "博客管理" && pass "/blog 页面渲染成功" || fail "/blog 页面异常: $(echo "$TXT" | head -c 200)"
echo "$TXT" | grep -q "文章列表" && pass "二级导航「文章列表」可见" || fail "二级导航缺失"
echo "$TXT" | grep -q "新建文章" && pass "「新建文章」入口可见" || fail "「新建文章」入口缺失"

info "4. 分类管理：新建分类"
"$PCLI" goto http://127.0.0.1:3001/blog/categories >/dev/null 2>&1
sleep 3
"$PCLI" fill "#new-name" "$CAT_NAME" >/dev/null 2>&1
"$PCLI" fill "#new-slug" "$CAT_SLUG" >/dev/null 2>&1
"$PCLI" fill "#new-sortOrder" "3" >/dev/null 2>&1
"$PCLI" fill "#new-description" "行业资讯与趋势" >/dev/null 2>&1
"$PCLI" click 'button:has-text("创建分类")' >/dev/null 2>&1
if wait_text "$CAT_NAME" 15; then
  pass "分类创建成功并出现在列表：$CAT_NAME"
else
  fail "分类未出现在列表"
fi
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "启用" && pass "分类状态显示「启用」" || fail "分类状态列异常"

info "5. 标签管理：新建标签"
"$PCLI" goto http://127.0.0.1:3001/blog/tags >/dev/null 2>&1
sleep 3
"$PCLI" fill "#new-tag-name" "$TAG_NAME" >/dev/null 2>&1
"$PCLI" fill "#new-tag-slug" "$TAG_SLUG" >/dev/null 2>&1
"$PCLI" click 'button:has-text("创建标签")' >/dev/null 2>&1
if wait_text "$TAG_NAME" 15; then
  pass "标签创建成功并出现在列表：$TAG_NAME"
else
  fail "标签未出现在列表"
fi

info "6. 新建文章（富文本 + 分类 + 标签 + 状态 + SEO）"
"$PCLI" goto http://127.0.0.1:3001/blog/create >/dev/null 2>&1
sleep 3
"$PCLI" fill "#title" "$POST_TITLE" >/dev/null 2>&1
"$PCLI" fill "#slug" "$POST_SLUG" >/dev/null 2>&1
"$PCLI" fill "#excerpt" "面向海外采购商的板材出口指南摘要" >/dev/null 2>&1

# 正文：注入含 XSS 载荷的 HTML，并触发 input 事件同步到隐藏字段
CONTENT='<h2>行业趋势</h2><p>板材出口保持增长，<strong>重点关注</strong>环保与可持续认证。</p><ul><li>CARB / E0 认证</li><li>FSC 森林认证</li></ul><script>alert(1)</script><img src="x" onerror="alert(1)">'
B64=$(printf '%s' "$CONTENT" | base64 -w0)
ED=$(evalstr "(() => { const ed = document.querySelector('[contenteditable]'); if (!ed) return 'noeditor'; ed.focus(); ed.innerHTML = new TextDecoder().decode(Uint8Array.from(atob('$B64'), c => c.charCodeAt(0))); ed.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()")
[ "$ED" = "ok" ] && pass "富文本编辑器注入正文成功" || fail "编辑器注入失败: $ED"
HIDDEN=$(evalstr "(() => { const el = document.querySelector('input[name=content]'); return el ? el.value.slice(0,40) : 'noinput'; })()")
echo "$HIDDEN" | grep -q "行业趋势" && pass "正文已同步到提交字段" || fail "正文未同步: $HIDDEN"

# 分类下拉（按选项文本匹配）
SEL=$(evalstr "(() => { const s = document.querySelector('#categoryId'); if (!s) return 'nosel'; const o = Array.from(s.options).find(x => x.textContent.includes('$CAT_NAME')); if (!o) return 'noopt'; s.value = o.value; s.dispatchEvent(new Event('change', {bubbles:true})); return 'ok'; })()")
[ "$SEL" = "ok" ] && pass "已选择分类：$CAT_NAME" || fail "分类选择失败: $SEL"

# 标签多选
TAGCLICK=$(evalstr "(() => { const b = Array.from(document.querySelectorAll('button[aria-pressed]')).find(x => x.textContent.trim() === '$TAG_NAME'); if (!b) return 'nobtn'; b.click(); return b.getAttribute('aria-pressed'); })()")
echo "$TAGCLICK" | grep -q "true" && pass "已选中标签：$TAG_NAME" || fail "标签选择失败: $TAGCLICK"

# 状态改为已发布
"$PCLI" select "#status" "PUBLISHED" >/dev/null 2>&1
ST=$(evalstr "document.querySelector('#status').value")
[ "$ST" = "PUBLISHED" ] && pass "状态已设为 PUBLISHED" || fail "状态设置失败: $ST"

# SEO / OG / Twitter
"$PCLI" fill "#seoTitle" "板材出口指南 | 百灵木业" >/dev/null 2>&1
"$PCLI" fill "#seoDescription" "面向海外采购商的板材出口指南，涵盖认证与规格要点" >/dev/null 2>&1
"$PCLI" fill "#seoKeywords" "plywood,export,guide" >/dev/null 2>&1
"$PCLI" fill "#canonicalUrl" "https://bailingwooden.com/blog/${POST_SLUG}" >/dev/null 2>&1
"$PCLI" fill "#ogTitle" "OG 标题-${RUN}" >/dev/null 2>&1
"$PCLI" fill "#ogDescription" "OG 描述-${RUN}" >/dev/null 2>&1
"$PCLI" fill "#ogImage" "https://bailingwooden.com/og-${RUN}.png" >/dev/null 2>&1
"$PCLI" fill "#twitterTitle" "TW 标题-${RUN}" >/dev/null 2>&1
"$PCLI" fill "#twitterDescription" "TW 描述-${RUN}" >/dev/null 2>&1
pass "SEO / OG / Twitter 字段填写完成"

"$PCLI" click 'button:has-text("创建文章")' >/dev/null 2>&1
POST_ID=""
for _ in $(seq 1 20); do
  P=$(evalstr "location.pathname")
  case "$P" in
    /blog/*/edit) POST_ID=$(echo "$P" | cut -d/ -f3); break ;;
  esac
  sleep 1
done
[ -n "$POST_ID" ] && pass "创建成功并跳转编辑页（id=$POST_ID）" || fail "创建后未跳转编辑页"

info "7. 编辑页校验（SEO 持久化 + 正文 XSS 已过滤 + 自动发布时间）"
sleep 2
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "已发布" && pass "状态显示「已发布」" || fail "状态未显示已发布"
echo "$TXT" | grep -q "板材出口指南 | 百灵木业" && pass "SEO 标题已持久化" || fail "SEO 标题未持久化"
echo "$TXT" | grep -q "plywood,export,guide" && pass "SEO 关键词已持久化" || fail "SEO 关键词未持久化"
echo "$TXT" | grep -q "OG 标题-${RUN}" && pass "OG 标题已持久化（预留字段可用）" || fail "OG 标题未持久化"
echo "$TXT" | grep -q "TW 标题-${RUN}" && pass "Twitter 标题已持久化（预留字段可用）" || fail "Twitter 标题未持久化"
echo "$TXT" | grep -q "$CAT_NAME" && pass "分类关联正确" || fail "分类关联缺失"
echo "$TXT" | grep -q "$TAG_NAME" && pass "标签关联正确" || fail "标签关联缺失"
PUB=$(evalstr "(() => { const el = document.querySelector('#publishedAt'); return el ? el.value : 'noinput'; })()")
[ -n "$PUB" ] && [ "$PUB" != "noinput" ] && pass "发布时间已自动填充：$PUB" || fail "发布时间未自动填充: $PUB"
BODY=$(evalstr "(() => { const ed = document.querySelector('[contenteditable]'); return ed ? ed.innerHTML : 'noeditor'; })()")
case "$BODY" in
  *"<script"*) fail "正文仍含 <script>（XSS 过滤失效）" ;;
  *"onerror"*) fail "正文仍含 onerror（XSS 过滤失效）" ;;
  *"行业趋势"*) pass "正文已保存且不安全标签被过滤" ;;
  *) fail "正文内容异常: $(echo "$BODY" | head -c 120)" ;;
esac

info "8. 媒体库上传封面素材"
"$PCLI" goto http://127.0.0.1:3001/media >/dev/null 2>&1
sleep 3
"$PCLI" drop '[aria-label^="上传图片"]' --path "$PNG" >/dev/null 2>&1
if wait_text "$ORIGINAL" 20; then
  pass "媒体上传成功：$ORIGINAL"
else
  fail "媒体上传后未见卡片"
fi

info "9. 从媒体库选择封面"
"$PCLI" goto "http://127.0.0.1:3001/blog/${POST_ID}/edit" >/dev/null 2>&1
sleep 3
"$PCLI" click 'button:has-text("从媒体库选择封面")' >/dev/null 2>&1
DLG=""
for _ in $(seq 1 15); do
  DLG=$(evalstr "(() => { const d = document.querySelector('[role=dialog]'); return d ? d.innerText.slice(0,80) : 'nodialog'; })()")
  [ "$DLG" != "nodialog" ] && break
  sleep 1
done
echo "$DLG" | grep -q "从媒体库选择图片" && pass "封面选择弹窗已打开" || fail "封面弹窗未打开: $DLG"
PICK=$(evalstr "(() => { const d = document.querySelector('[role=dialog]'); if (!d) return 'nodialog'; const b = Array.from(d.querySelectorAll('button')).find(x => x.innerText.includes('$ORIGINAL')); if (!b) return 'nopick'; b.click(); return 'picked'; })()")
[ "$PICK" = "picked" ] && pass "已在弹窗中选中封面：$ORIGINAL" || fail "封面选择失败: $PICK"
sleep 2
COVERID=$(evalstr "(() => { const el = document.querySelector('input[name=coverMediaId]'); return el ? el.value : 'noinput'; })()")
[ -n "$COVERID" ] && [ "$COVERID" != "noinput" ] && pass "coverMediaId 已写入（$COVERID）" || fail "coverMediaId 未写入"
"$PCLI" click 'button:has-text("保存修改")' >/dev/null 2>&1
if wait_text "已保存" 15; then
  pass "封面保存成功（页面提示「已保存」）"
else
  fail "封面保存未出现成功提示"
fi
sleep 2
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "$ORIGINAL" && pass "封面预览显示原始文件名" || echo "INFO  封面预览未显示原始文件名（仅显示图片，属正常）"
COVERIMG=$(evalstr "(() => { const imgs = Array.from(document.querySelectorAll('main img')); const hit = imgs.find(i => (i.getAttribute('src')||'').includes('/uploads/media/')); return hit ? (hit.complete && hit.naturalWidth ? hit.naturalWidth + 'x' + hit.naturalHeight : 'loading') : 'noimg'; })()")
echo "INFO  封面图加载状态: $COVERIMG"

info "10. 列表页校验（封面缩略图 / 状态 / 分类 / 标签）"
"$PCLI" goto http://127.0.0.1:3001/blog >/dev/null 2>&1
sleep 3
if wait_text "$POST_TITLE" 10; then
  pass "文章出现在列表：$POST_TITLE"
else
  fail "文章未出现在列表"
fi
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "已发布" && pass "列表状态显示「已发布」" || fail "列表状态异常"
echo "$TXT" | grep -q "$CAT_NAME" && pass "列表显示分类" || fail "列表缺分类"
echo "$TXT" | grep -q "$TAG_NAME" && pass "列表显示标签" || fail "列表缺标签"
THUMB=$(evalstr "(() => { const imgs = Array.from(document.querySelectorAll('main img')); const hit = imgs.find(i => (i.getAttribute('src')||'').includes('/uploads/media/')); if (!hit) return 'noimg'; hit.scrollIntoView({block:'center'}); return hit.complete && hit.naturalWidth ? hit.naturalWidth + 'x' + hit.naturalHeight : 'loading'; })()")
for _ in $(seq 1 10); do
  [ "$THUMB" = "640x480" ] && break
  THUMB=$(evalstr "(() => { const imgs = Array.from(document.querySelectorAll('main img')); const hit = imgs.find(i => (i.getAttribute('src')||'').includes('/uploads/media/')); return hit ? (hit.complete && hit.naturalWidth ? hit.naturalWidth + 'x' + hit.naturalHeight : 'loading') : 'noimg'; })()")
  sleep 1
done
[ "$THUMB" = "640x480" ] && pass "列表封面缩略图真实加载（naturalWidth 640）" || fail "列表封面缩略图异常: $THUMB"

info "11. 引用检查：被博客封面引用的媒体不可删除"
"$PCLI" goto http://127.0.0.1:3001/media >/dev/null 2>&1
sleep 3
"$PCLI" eval "(() => { const cards = Array.from(document.querySelectorAll('li')); const card = cards.find(li => li.innerText.includes('$ORIGINAL')); if (!card) return 'nocard'; const btn = Array.from(card.querySelectorAll('button')).find(b => b.innerText.trim() === '删除'); if (!btn) return 'nobtn'; btn.click(); return 'clicked'; })()" >/dev/null 2>&1
sleep 1
"$PCLI" eval "(() => { const cards = Array.from(document.querySelectorAll('li')); const card = cards.find(li => li.innerText.includes('$ORIGINAL')); if (!card) return 'nocard'; const btn = Array.from(card.querySelectorAll('button')).find(b => b.innerText.trim() === '确认删除'); if (!btn) return 'nobtn'; btn.click(); return 'confirm'; })()" >/dev/null 2>&1
sleep 3
ERR=$(evalstr "(() => { const el = document.querySelector('li [role=alert]'); return el ? el.innerText : 'noalert'; })()")
echo "$ERR" | grep -q "引用" && pass "删除被拒并给出中文提示：$ERR" || fail "引用检查提示异常: $ERR"
STILL=$(evalstr "document.querySelector('main').innerText.includes('$ORIGINAL') ? 'present' : 'gone'")
[ "$STILL" = "present" ] && pass "媒体仍在库中（未被误删）" || fail "媒体被误删"

info "12. 删除文章（两步确认）"
"$PCLI" goto http://127.0.0.1:3001/blog >/dev/null 2>&1
sleep 3
"$PCLI" eval "(() => { const rows = Array.from(document.querySelectorAll('tr')); const row = rows.find(r => r.innerText.includes('$POST_TITLE')); if (!row) return 'norow'; const btn = Array.from(row.querySelectorAll('button')).find(b => b.innerText.trim() === '删除'); if (!btn) return 'nobtn'; btn.click(); return 'clicked'; })()" >/dev/null 2>&1
sleep 1
"$PCLI" eval "(() => { const rows = Array.from(document.querySelectorAll('tr')); const row = rows.find(r => r.innerText.includes('$POST_TITLE')); if (!row) return 'norow'; const btn = Array.from(row.querySelectorAll('button')).find(b => b.innerText.trim() === '确认'); if (!btn) return 'nobtn'; btn.click(); return 'confirm'; })()" >/dev/null 2>&1
if wait_text "$POST_TITLE" 3; then
  sleep 3
  TXT=$(evalstr "document.querySelector('main').innerText")
  echo "$TXT" | grep -q "$POST_TITLE" && fail "删除后文章仍在列表" || pass "两步删除成功，文章已从列表移除"
else
  pass "两步删除成功，文章已从列表移除"
fi

info "13. 截图留档"
"$PCLI" goto http://127.0.0.1:3001/blog >/dev/null 2>&1
sleep 2
"$PCLI" screenshot 2>&1 | tail -2

"$PCLI" close >/dev/null 2>&1
rm -f "$PNG"

# 末清理：移除本次测试数据（测试账号保留，供复用）
cleanup_test_data

echo ""
echo "===== Phase 4.4 博客 CMS 浏览器流程结束 ====="
