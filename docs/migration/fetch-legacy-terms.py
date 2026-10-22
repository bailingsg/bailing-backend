#!/usr/bin/env python3
"""Phase 5.4.3 - 补抓旧站分类/标签术语名称（小负载，带重试）。

wp/v2/product 与 wp/v2/posts 只给术语 ID，名称需从术语端点解析。
产物：legacy-raw/terms-{product_cat,product_tag,categories,tags}.json
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
MAX_RETRIES = 10
TIMEOUT = 60

TARGETS = {
    "product_cat": "/wp-json/wp/v2/product_cat?per_page=100",
    "product_tag": "/wp-json/wp/v2/product_tag?per_page=100",
    "categories": "/wp-json/wp/v2/categories?per_page=100",
    "tags": "/wp-json/wp/v2/tags?per_page=100",
}


def fetch(url: str):
    last = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "BailingMigrationBot/2.0 (read-only)"}
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8", errors="replace"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError) as e:
            last = f"{type(e).__name__}: {e}"
            delay = min(3 * (2 ** (attempt - 1)), 40)
            print(f"    [retry {attempt}/{MAX_RETRIES}] sleep {delay}s -> {last}", flush=True)
            time.sleep(delay)
    raise RuntimeError(f"failed: {url} -> {last}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    summary = {}
    for name, path in TARGETS.items():
        print(f"[fetch] {path}", flush=True)
        try:
            data = fetch(BASE + path)
            terms = {}
            for t in data:
                terms[str(t["id"])] = {
                    "id": t["id"],
                    "name": t.get("name"),
                    "slug": t.get("slug"),
                    "count": t.get("count"),
                    "parent": t.get("parent"),
                    "description": t.get("description"),
                }
            out = os.path.join(OUT_DIR, f"terms-{name}.json")
            with open(out, "w", encoding="utf-8") as f:
                json.dump(terms, f, ensure_ascii=False, indent=1)
            summary[name] = {"count": len(terms), "path": out}
            print(f"    saved {out} ({len(terms)} terms)", flush=True)
        except RuntimeError as e:
            summary[name] = {"error": str(e)}
            print(f"    [FAIL] {e}", flush=True)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    failed = [k for k, v in summary.items() if "error" in v]
    if failed:
        print(f"[!] 失败端点: {failed}（可重跑）", flush=True)
        sys.exit(2)


if __name__ == "__main__":
    main()
