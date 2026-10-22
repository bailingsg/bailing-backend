#!/usr/bin/env python3
"""Phase 5.4.3 - 本地图片索引构建（只读扫描，不移动/修改任何文件）。

扫描 C:\\Users\\Administrator\\Desktop\\bailing-image-export 全目录，建立索引：
- 路径 / 文件名 / 扩展名 / 大小 / 宽高（文件头解析）/ SHA-256
- 与 manifest.csv 元数据关联（原始URL、分类、归属 slug、图集顺序、附件ID、ALT、Caption、上传路径、上传日期、出现页面、下载状态）
- 重复检测：按 SHA-256 与按「归属+图集顺序」双口径

产物：docs/migration/legacy-image-index.json + image-index-summary.json
"""
import csv
import hashlib
import json
import os
import struct
from collections import defaultdict

EXPORT_DIR = r"C:\Users\Administrator\Desktop\bailing-image-export"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_INDEX = os.path.join(HERE, "legacy-image-index.json")
OUT_SUMMARY = os.path.join(HERE, "image-index-summary.json")


def image_size(path: str, ext: str):
    """从文件头解析宽高，失败返回 (None, None)。"""
    try:
        with open(path, "rb") as f:
            head = f.read(64)
            if ext in (".png",):
                if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
                    w, h = struct.unpack(">II", head[16:24])
                    return w, h
            elif ext in (".webp",):
                if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                    fmt = head[12:16]
                    if fmt == b"VP8X":
                        w = 1 + (head[24] | (head[25] << 8) | (head[26] << 16))
                        h = 1 + (head[27] | (head[28] << 8) | (head[29] << 16))
                        return w, h
                    if fmt == b"VP8 ":
                        w, h = struct.unpack("<HH", head[26:30])
                        return w & 0x3FFF, h & 0x3FFF
                    if fmt == b"VP8L":
                        b = head[21:25]
                        bits = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)
                        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            elif ext in (".jpg", ".jpeg"):
                data = head
                with open(path, "rb") as f:
                    data = f.read(65536)
                i = 2
                while i < len(data) - 9:
                    if data[i] != 0xFF:
                        i += 1
                        continue
                    marker = data[i + 1]
                    if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                        return w, h
                    if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                        i += 2
                        continue
                    seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
                    i += 2 + seg_len
            elif ext == ".gif":
                if head[:6] in (b"GIF87a", b"GIF89a"):
                    w, h = struct.unpack("<HH", head[6:10])
                    return w, h
            elif ext == ".svg":
                return "svg", "svg"
    except (OSError, struct.error):
        return None, None
    return None, None


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest():
    path = os.path.join(EXPORT_DIR, "manifest.csv")
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows.append(r)
    return rows


def main():
    manifest = load_manifest()
    by_local_path = {}
    for r in manifest:
        lp = (r.get("本地路径") or "").strip()
        if lp:
            by_local_path[lp.replace("\\", "/")] = r

    files = []
    for root, _dirs, names in os.walk(EXPORT_DIR):
        for n in names:
            if n in ("manifest.csv", "README.md", "_stats.json", "_plan.json"):
                continue
            full = os.path.join(root, n)
            rel = os.path.relpath(full, EXPORT_DIR).replace("\\", "/")
            ext = os.path.splitext(n)[1].lower()
            size = os.path.getsize(full)
            w, h = image_size(full, ext)
            digest = sha256_of(full)
            m = by_local_path.get(rel)
            files.append(
                {
                    "localPath": rel,
                    "absolutePath": full,
                    "filename": n,
                    "ext": ext,
                    "sizeBytes": size,
                    "width": w,
                    "height": h,
                    "sha256": digest,
                    "manifest": m,
                    "inManifest": m is not None,
                }
            )

    files.sort(key=lambda x: x["localPath"])

    # 重复检测
    by_sha = defaultdict(list)
    by_slot = defaultdict(list)  # 归属 slug + 图集顺序
    for f in files:
        by_sha[f["sha256"]].append(f["localPath"])
        m = f.get("manifest")
        if m and (m.get("分类") == "product") and (m.get("图集顺序") or "").strip() != "":
            key = (m.get("归属(产品/文章/页面slug)"), m.get("图集顺序"))
            by_slot[key].append(f["localPath"])

    dup_sha = {k: v for k, v in by_sha.items() if len(v) > 1}
    dup_slot = {f"{k[0]}#{k[1]}": v for k, v in by_slot.items() if len(v) > 1}

    by_bucket = defaultdict(int)
    no_meta = []
    dims_missing = []
    for f in files:
        m = f.get("manifest")
        bucket = (m.get("分类") if m else "unlisted") or "unlisted"
        by_bucket[bucket] += 1
        if not m:
            no_meta.append(f["localPath"])
        if f["width"] in (None, "svg"):
            dims_missing.append(f["localPath"])

    # 与 manifest 对账
    manifest_missing_on_disk = [lp for lp in by_local_path if not any(f["localPath"] == lp for f in files)]

    summary = {
        "scannedDir": EXPORT_DIR,
        "totalFiles": len(files),
        "manifestRows": len(manifest),
        "byBucket": dict(by_bucket),
        "filesNotInManifest": no_meta,
        "manifestEntriesMissingOnDisk": manifest_missing_on_disk,
        "dimensionsUnresolved": dims_missing,
        "duplicateSha256Groups": dup_sha,
        "duplicateProductSlotGroups": dup_slot,
        "duplicateSha256FileCount": sum(len(v) for v in dup_sha.values()),
    }

    with open(OUT_INDEX, "w", encoding="utf-8") as f:
        json.dump(files, f, ensure_ascii=False, indent=1)
    with open(OUT_SUMMARY, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False, indent=2)[:3000])
    print(f"\n[saved] {OUT_INDEX} ({len(files)} files)")
    print(f"[saved] {OUT_SUMMARY}")


if __name__ == "__main__":
    main()
