#!/bin/bash
# Phase 4.2 Admin 浏览器全流程验证（选择器 + URL 轮询版）
set -u
PCLI="C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/.bin/playwright-cli.cmd"
cd /d/com.bailingwooden/bailing-admin || exit 1
RUN=$(date +%s)
CAT_NAME="Playwright Cat ${RUN}"
PROD_NAME="Playwright Oak ${RUN}"
PROD_SLUG="playwright-oak-${RUN}"
PNG="C:/Users/Administrator/AppData/Local/Temp/pw-test-${RUN}.png"

node -e "require('fs').writeFileSync(process.argv[1], Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,1,2,3,4,5,6,7,8]))" "$PNG" || exit 1

info() { echo "== $* =="; }
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; }

# eval 结果解析：### Result 的下一行（带引号）
evalstr() { "$PCLI" eval "() => $1" 2>/dev/null | awk '/### Result/{getline; print; exit}' | tr -d '"' | tr -d '\r'; }
wait_url() { # $1=期望路径包含串  $2=最多秒数
  for _ in $(seq 1 "$2"); do
    U=$(evalstr "location.pathname")
    case "$U" in *"$1"*) echo "$U"; return 0 ;; esac
    sleep 1
  done
  echo "$U"; return 1
}

info "1. 登录"
"$PCLI" open http://127.0.0.1:3001/login >/dev/null 2>&1
sleep 2
"$PCLI" fill "#email" "admin@bailingwooden.com" >/dev/null 2>&1
"$PCLI" fill "#password" "BlZA66DJgHwIZ2Spjm9" >/dev/null 2>&1
"$PCLI" click "button[type=submit]" >/dev/null 2>&1
U=$(wait_url "/dashboard" 15)
[ "$U" = "/dashboard" ] && pass "登录成功进入 /dashboard" || fail "登录后 URL: $U"

info "2. 创建分类 ${CAT_NAME}"
"$PCLI" goto http://127.0.0.1:3001/categories >/dev/null 2>&1
sleep 3
"$PCLI" fill "#new-name" "$CAT_NAME" >/dev/null 2>&1
"$PCLI" fill "#new-slug" "pw-cat-${RUN}" >/dev/null 2>&1
"$PCLI" click "text=创建分类" >/dev/null 2>&1
sleep 4
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "$CAT_NAME" && pass "分类创建成功并出现在列表" || fail "分类未出现在列表"

info "3. 创建产品 ${PROD_NAME}"
"$PCLI" goto http://127.0.0.1:3001/products/create >/dev/null 2>&1
sleep 3
OPTS=$(evalstr "Array.from(document.querySelectorAll('#categoryId option')).map(o => o.text + '=' + o.value).join('|')")
CAT_VALUE=$(echo "$OPTS" | tr '|' '\n' | grep "^${CAT_NAME}=" | head -1 | cut -d= -f2)
info "目标分类 id: ${CAT_VALUE:0:8}…"
[ -n "$CAT_VALUE" ] && pass "分类下拉含新建分类" || fail "分类下拉缺少新建分类: $OPTS"
"$PCLI" fill "#name" "$PROD_NAME" >/dev/null 2>&1
"$PCLI" fill "#slug" "$PROD_SLUG" >/dev/null 2>&1
"$PCLI" fill "#description" "Playwright 自动化创建的产品描述（不少于十字）。" >/dev/null 2>&1
"$PCLI" select "#categoryId" "$CAT_VALUE" >/dev/null 2>&1
"$PCLI" click "text=创建产品" >/dev/null 2>&1
U=$(wait_url "/products/" 20)
case "$U" in
  */products/*/edit) pass "创建成功并跳转编辑页 ($U)" ;;
  *) fail "创建后未跳转编辑页: $U" ;;
esac

info "4. 编辑页回显"
TXT=$(evalstr "document.querySelector('main').innerText.slice(0,400)")
echo "$TXT" | grep -q "$PROD_NAME" && pass "编辑页回显产品名称" || fail "编辑页未回显: $TXT"

info "5. 上传图片"
"$PCLI" click "#file" >/dev/null 2>&1
sleep 1
"$PCLI" upload "$PNG" 2>&1 | tr -d '\r' | tail -1
sleep 1
"$PCLI" click "text=上传" >/dev/null 2>&1
sleep 5
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "主图" && pass "图片上传成功且首图默认主图" || fail "未见主图标记（上传可能失败）"

info "6. 删除产品（两步确认）"
"$PCLI" click 'button:has-text("删除产品")' >/dev/null 2>&1
sleep 1
"$PCLI" click 'button:has-text("确认删除")' >/dev/null 2>&1
U=$(wait_url "/products" 15)
[ "$U" = "/products" ] && pass "删除成功并返回列表页" || fail "删除后 URL: $U"
TXT=$(evalstr "document.querySelector('main').innerText")
echo "$TXT" | grep -q "$PROD_NAME" && fail "列表中仍见已删产品" || pass "列表已无该产品"
# 清理测试分类（两步确认）
"$PCLI" goto http://127.0.0.1:3001/categories >/dev/null 2>&1
sleep 3
ROW_BTN=$(evalstr "(() => { const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.innerText.includes('${CAT_NAME}')); if (!row) return 'norow'; const del = Array.from(row.querySelectorAll('button')).find(b => b.innerText.trim() === '删除'); return del ? 'found' : 'nobtn'; })()")
if [ "$ROW_BTN" = "found" ]; then
  "$PCLI" eval "(() => { const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.innerText.includes('${CAT_NAME}')); const del = Array.from(row.querySelectorAll('button')).find(b => b.innerText.trim() === '删除'); del.click(); })()" >/dev/null 2>&1
  sleep 1
  "$PCLI" eval "(() => { const btns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.trim() === '确认'); if (btns.length) btns[btns.length-1].click(); })()" >/dev/null 2>&1
  sleep 3
  TXT=$(evalstr "document.querySelector('main').innerText")
  echo "$TXT" | grep -q "$CAT_NAME" && fail "测试分类未删除" || pass "测试分类已删除"
else
  info "未找到测试分类行（$ROW_BTN）"
fi

"$PCLI" close >/dev/null 2>&1
echo ""
echo "===== 流程结束 ====="
