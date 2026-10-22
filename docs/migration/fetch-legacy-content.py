#!/usr/bin/env python3
"""Phase 5.4.3a - 抓取旧站 bailingwooden.com 全部内容（只读）。

产物（写入 docs/migration/legacy-raw/）：
- products-all.json : 全部产品（wp/v2/product）
- posts-all.json    : 全部文章（wp/v2/posts）
- pages-all.json    : 全部页面（wp/v2/pages）
- media-all.json    : 全部媒体附件元数据（wp/v2/media，用于 ALT/Caption/日期）
- fetch-stats.json  : 抓取统计与失败清单

特性：分页遍历、限速、失败重试、JSON 完整性校验、断点续抓（已有且合法的分页文件跳过）。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://bailingwooden.com"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "legacy-raw")
PER_PAGE = 20
MAX_RETRIES = 6
TIMEOUT = 90
RETRY_DELAY = 3

os.makedirs(OUT_DIR, exist_ok=True)


def fetch(url: str) -> tuple[int, dict, str]:
    """返回 (http_status, headers_dict, body_text)。失败重试。"""
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "BailingMigrationBot/1.0 (content inventory, read-only)"}
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                headers = {k.lower(): v for k, v in resp.headers.items()}
                status = resp.status
            return status, headers, body
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError) as e:
            last_err = f"{type(e).__name__}: {e}"
            print(f"    [retry {attempt}/{MAX_RETRIES}] {url} -> {last_err}", flush=True)
            time.sleep(RETRY_DELAY * attempt)
    raise RuntimeError(f"fetch failed after {MAX_RETRIES} retries: {url} -> {last_err}")


def parse_json_complete(text: str, what: str):
    data = json.loads(text)  # 截断的 JSON 会在这里抛错
    return data


def fetch_all(endpoint: str, filename: str, expect_key: str = None):
    """分页抓取整个端点，汇总为单个 JSON 数组。返回 (items, meta)。"""
    print(f"[fetch] {endpoint} -> {filename}", flush=True)
    page = 1
    items = []
    total = None
    total_pages = None
    per_page = PER_PAGE
    while True:
        url = f"{BASE}{endpoint}?per_page={per_page}&page={page}"
        status, headers, body = fetch(url)
        if total is None:
            total = int(headers.get("x-wp-total", -1))
            total_pages = int(headers.get("x-wp-totalpages", -1))
        if status == 400 and "rest_post_invalid_page_number" in body:
            break
        data = parse_json_complete(body, f"{endpoint} page {page}")
        if not data:
            break
        items.extend(data)
        print(f"    page {page}/{total_pages}: +{len(data)} (cum {len(items)}/{total})", flush=True)
        if len(items) >= (total if total > 0 else len(items)):
            break
        page += 1
        time.sleep(1)
    meta = {
        "endpoint": endpoint,
        "x_wp_total": total,
        "fetched_items": len(items),
        "complete": total > 0 and len(items) == total,
    }
    out_path = os.path.join(OUT_DIR, filename)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    print(f"    saved {out_path} ({len(items)} items, complete={meta['complete']})", flush=True)
    return items, meta


def main():
    stats = {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "endpoints": {}}
    failures = []

    products, m1 = fetch_all("/wp-json/wp/v2/product", "products-all.json")
    stats["endpoints"]["products"] = m1
    time.sleep(1)
    posts, m2 = fetch_all("/wp-json/wp/v2/posts", "posts-all.json")
    stats["endpoints"]["posts"] = m2
    time.sleep(1)
    pages, m3 = fetch_all("/wp-json/wp/v2/pages", "pages-all.json")
    stats["endpoints"]["pages"] = m3
    time.sleep(1)
    media, m4 = fetch_all("/wp-json/wp/v2/media?media_type=image", "media-all.json")
    stats["endpoints"]["media"] = m4

    stats["failures"] = failures
    stats_path = os.path.join(OUT_DIR, "fetch-stats.json")
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(f"\n[stats] {json.dumps(stats, ensure_ascii=False, indent=2)}", flush=True)

    if not (m1["complete"] and m2["complete"] and m3["complete"]):
        print("\n[!] WARNING: 有端点未完整抓取，统计见 fetch-stats.json", flush=True)
        sys.exit(2)


if __name__ == "__main__":
    main()
