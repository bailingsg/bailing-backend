#!/usr/bin/env python3
"""Phase 5.4.3a - 抓取旧站 bailingwooden.com 全部内容（只读）v2。

v2 变更（v1 因站点响应极慢、大分页反复超时失败）：
- 每个分页单独落盘 pages/<endpoint>-p<N>.json，支持断点续抓（合法 JSON 即跳过）
- 重试增至 10 次、指数退避（3s→45s），单次超时 120s
- posts/pages 每页 10 条，缩小单次响应体
- 汇总产物 products-all.json / posts-all.json / pages-all.json / fetch-stats-v2.json
- 媒体元数据改用本地导出目录的 manifest.csv（2026-10-13 已验证导出 406/407 附件），
  不再重复抓取 /wp/v2/media（站点慢、非必需）

用法：
  python fetch-legacy-content.py [--per-page 10] [--endpoints products,posts,pages]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = "https://bailingwooden.com"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "legacy-raw")
PAGES_DIR = os.path.join(OUT_DIR, "pages")
MAX_RETRIES = 10
TIMEOUT = 120

os.makedirs(PAGES_DIR, exist_ok=True)

# 产品分页已在 v1 完成（products-all.json 完整），默认跳过
ENDPOINT_MAP = {
    "products": "/wp-json/wp/v2/product",
    "posts": "/wp-json/wp/v2/posts",
    "pages": "/wp-json/wp/v2/pages",
}
DEFAULT_ENDPOINTS = ["posts", "pages"]
POST_FIELDS = (
    "id,date,date_gmt,modified,modified_gmt,slug,link,status,type,title,content,"
    "excerpt,author,featured_media,categories,tags,sticky,meta"
)


def parse_args():
    args = sys.argv[1:]
    per_page = 10
    endpoints = list(DEFAULT_ENDPOINTS)
    i = 0
    while i < len(args):
        if args[i] == "--per-page" and i + 1 < len(args):
            per_page = int(args[i + 1])
            i += 2
        elif args[i] == "--endpoints" and i + 1 < len(args):
            endpoints = [x for x in args[i + 1].split(",") if x]
            i += 2
        else:
            i += 1
    return per_page, endpoints


def fetch(url: str):
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "BailingMigrationBot/2.0 (read-only)"}
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                headers = {k.lower(): v for k, v in resp.headers.items()}
                status = resp.status
            return status, headers, body
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError) as e:
            last_err = f"{type(e).__name__}: {e}"
            delay = min(3 * (2 ** (attempt - 1)), 45)
            print(f"    [retry {attempt}/{MAX_RETRIES}] sleep {delay}s -> {last_err}", flush=True)
            time.sleep(delay)
    raise RuntimeError(f"fetch failed after {MAX_RETRIES} retries: {url} -> {last_err}")


def page_file(endpoint: str, page: int) -> str:
    return os.path.join(PAGES_DIR, f"{endpoint.strip('/').replace('/', '_')}-p{page}.json")


def load_page(path: str):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, OSError):
        return None
    return None


def save_page(path: str, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def fetch_endpoint(endpoint: str, per_page: int, extra_params: str = ""):
    name = endpoint.strip("/").replace("/", "_")
    print(f"[fetch] {BASE}{endpoint} (per_page={per_page})", flush=True)
    page = 1
    items = []
    total = None
    total_pages = None
    while True:
        pf = page_file(name, page)
        cached = load_page(pf)
        if cached is not None:
            print(f"    page {page}: 使用断点缓存（{len(cached)} 条）", flush=True)
            items.extend(cached)
            if total is None:
                # 缓存页缺少响应头信息，发起一次轻量探测（per_page=1）拿总数
                try:
                    _, h, _ = fetch(f"{BASE}{endpoint}?per_page=1&page=1{extra_params}")
                    total = int(h.get("x-wp-total", -1))
                    total_pages = int(h.get("x-wp-totalpages", -1))
                except RuntimeError:
                    total = total or -1
            page += 1
            continue
        url = f"{BASE}{endpoint}?per_page={per_page}&page={page}{extra_params}"
        status, headers, body = fetch(url)
        if total is None:
            total = int(headers.get("x-wp-total", -1))
            total_pages = int(headers.get("x-wp-totalpages", -1))
            print(f"    x-wp-total={total}, x-wp-totalpages={total_pages}", flush=True)
        if status == 400 and "rest_post_invalid_page_number" in body:
            break
        data = json.loads(body)  # 截断 JSON 在此抛错 → 不落盘、下轮重试
        if not data:
            break
        save_page(pf, data)
        print(f"    page {page}/{total_pages}: +{len(data)} (cum {len(items) + len(data)}/{total})", flush=True)
        items.extend(data)
        if total > 0 and len(items) >= total:
            break
        if page >= (total_pages or page):
            break
        page += 1
        time.sleep(1)
    meta = {
        "endpoint": endpoint,
        "per_page": per_page,
        "x_wp_total": total,
        "fetched_items": len(items),
        "complete": total > 0 and len(items) == total,
    }
    out_path = os.path.join(OUT_DIR, f"{name}-all.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    print(f"    saved {out_path} ({len(items)} items, complete={meta['complete']})", flush=True)
    return items, meta


def main():
    per_page, endpoints = parse_args()
    stats = {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "script": "fetch-legacy-content.py v2",
        "endpoints": {},
    }
    for ep in endpoints:
        path = ENDPOINT_MAP.get(ep)
        if not path:
            print(f"[skip] 未知端点 {ep}（可用: {list(ENDPOINT_MAP)}）", flush=True)
            continue
        extra = f"&_fields={POST_FIELDS}" if path.endswith("/posts") else ""
        _, meta = fetch_endpoint(path, per_page, extra)
        stats["endpoints"][path] = meta
        time.sleep(1)
    stats_path = os.path.join(OUT_DIR, "fetch-stats-v2.json")
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(f"\n[stats] {json.dumps(stats, ensure_ascii=False, indent=2)}", flush=True)
    incomplete = [k for k, v in stats["endpoints"].items() if not v["complete"]]
    if incomplete:
        print(f"\n[!] 未完整抓取的端点: {incomplete}（可重跑续传）", flush=True)
        sys.exit(2)
    print("\n[ok] 全部端点完整抓取", flush=True)


if __name__ == "__main__":
    main()
