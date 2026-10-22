#!/usr/bin/env python3
"""生成 legacy-image-mapping.csv（台账 + 图片索引 + 迁移报告合成）。"""
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ledger = json.load(open(os.path.join(HERE, "legacy-migration-ledger.json"), encoding="utf-8"))
idx = json.load(open(os.path.join(HERE, "legacy-image-index.json"), encoding="utf-8"))

byid = {}
for e in idx:
    m = e.get("manifest")
    if m and m.get("附件ID"):
        byid.setdefault(m["附件ID"], e)

# 产品图集用途
prod_gallery = {}
for p in ledger.get("products", {}).values():
    for aid in p.get("galleryAttachmentIds", []) or []:
        prod_gallery.setdefault(aid, []).append(p["slug"])

# 文章封面/内嵌用途
post_use = {}
for pl in ledger.get("posts", {}).values():
    cov = pl.get("coverAttachmentId")
    if cov:
        post_use.setdefault(cov, []).append("post-cover: " + pl["slug"])

att = ledger.get("attachments", {})
rows = []
verified = 0
for aid, le in att.items():
    e = byid.get(aid)
    m = e.get("manifest") if e else None
    purpose = ""
    if aid in prod_gallery:
        purpose = "product-gallery: " + ",".join(prod_gallery[aid])
    if aid in post_use:
        purpose += ("; " if purpose else "") + "; ".join(post_use[aid])
    if not purpose:
        purpose = "post-inline"
    ok = le.get("mediaAssetId", "(dry-run)") not in ("(dry-run)", "")
    if ok:
        verified += 1
    rows.append(
        {
            "源站图片URL": (m or {}).get("原始URL", ""),
            "原始文件名": (m or {}).get("本地路径", "").split("/")[-1] if m else "",
            "本地匹配文件": e["localPath"] if e else "",
            "SHA256": le.get("sha256", ""),
            "目标媒体URL": le.get("url", ""),
            "目标storageKey": le.get("storageKey", ""),
            "关联产品/文章": purpose,
            "图集顺序": (m or {}).get("图集顺序", ""),
            "附件ID": aid,
            "ALT": (m or {}).get("图像ALT", ""),
            "匹配成功": "yes" if e else "no",
            "验证成功": "yes" if ok and (m or {}).get("原始URL") else ("partial" if ok else "no"),
            "需要人工处理": "",
        }
    )

out = os.path.join(HERE, "legacy-image-mapping.csv")
with open(out, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print("mapping rows:", len(rows), "| registered(verified):", verified)
print("saved:", out)
