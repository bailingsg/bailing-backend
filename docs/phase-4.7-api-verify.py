#!/usr/bin/env python3
"""
Phase 4.7 —— CMS → 公开 API 真实链路验证（API 层，零第三方依赖）

覆盖（对应用户任务书 §四十七 的验证要求）：
  A. 鉴权与越权防护（未认证 401 / 越权 403 / 权限子集放行）
  B. 内容状态隔离（DRAFT / ARCHIVED 不进公开 API，PUBLISHED 才可见）
  C. 公开 DTO 白名单（不泄漏 storageKey / status / authorId / createdBy 等内部字段）
  D. 站点内容 CMS 写入 → 公开读取（首页 hero 标题改动可见）
  E. 结构化字段安全（危险协议 URL 400；发布完整性 403）
  F. 导航启用状态过滤
  G. 媒体删除保护（被站点分区引用时不可删除）
  H. 分页上限（公开列表 pageSize 约束）

运行前置：
  · 后端已在 http://127.0.0.1:4000 运行（生产构建）
  · 数据库已执行 seed（site_sections / nav_items / admin_users）

用法：
  python docs/phase-4.7-api-verify.py

脚本会创建临时数据（测试文章 / 分区 / 导航项 / 编辑者账号）并在结束时清理，
同时把被修改的首页 hero 标题还原。
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:4000/api/v1"
ADMIN_EMAIL = "admin@bailingwooden.com"
ADMIN_PASSWORD = "123456789"
EDITOR_EMAIL = "pw-47-editor@bailingwooden.test"
EDITOR_PASSWORD = "Pw-Editor-2026!"
MARK = "PHASE47"

results: list[tuple[str, bool, str]] = []


def call(
    method: str,
    path: str,
    token: str | None = None,
    body: dict | None = None,
) -> tuple[int, dict | list | str]:
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("accept", "application/json")
    if data is not None:
        request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read().decode()
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        status = error.code
    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        parsed = raw
    return status, parsed


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, bool(condition), detail))
    flag = "PASS" if condition else "FAIL"
    print(f"[{flag}] {name}" + (f"  -- {detail}" if detail else ""))


def data_of(payload) -> object:
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def flat(value) -> str:
    """把响应对象压成字符串，用于内部字段泄漏检查"""
    return json.dumps(value, ensure_ascii=False)


def upload_media(token: str) -> str | None:
    """上传一张最小合法 PNG（自建素材，验证完即删除；不使用用户既有素材）"""
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    width = height = 8
    raw = b"".join(b"\x00" + bytes([200, 180, 140] * width) for _ in range(height))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )

    boundary = "----Phase47VerifyBoundary"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="phase47-verify.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode() + png + f"\r\n--{boundary}--\r\n".encode()

    request = urllib.request.Request(f"{BASE}/cms/media/upload", data=body, method="POST")
    request.add_header("content-type", f"multipart/form-data; boundary={boundary}")
    request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        print("      upload failed:", error.code, error.read().decode()[:200])
        return None
    return data_of(payload).get("id")


def main() -> int:
    print("=" * 78)
    print("Phase 4.7 API 链路验证")
    print("=" * 78)

    # ---------- A. 鉴权 ----------
    status, payload = call("GET", "/cms/site/sections")
    check("A1 未认证访问 CMS 接口被拒（401）", status == 401, f"status={status}")

    status, payload = call(
        "POST", "/auth/login", body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    token = data_of(payload).get("accessToken") if status < 300 else None
    check("A2 管理员登录成功并取得 accessToken", bool(token), f"status={status}")
    if not token:
        print("登录失败，后续用例无法继续")
        return 1

    status, payload = call("GET", "/cms/site/sections", token=token)
    check("A3 管理员可读站点分区（site.read）", status == 200, f"status={status}")

    # ---------- B/C. 博客 DRAFT 隔离 ----------
    slug = f"{MARK.lower()}-e2e-verify-{int(time.time())}"
    status, payload = call(
        "POST",
        "/cms/blog/posts",
        token=token,
        body={
            "title": f"{MARK} E2E Verification Post",
            "slug": slug,
            "excerpt": "临时验证文章（脚本结束时删除）",
            "content": "<p>Phase 4.7 链路验证正文。</p><script>alert(1)</script>",
            "status": "DRAFT",
        },
    )
    post_id = data_of(payload).get("id") if status < 300 else None
    check("B1 创建 DRAFT 博客文章成功", status < 300 and bool(post_id), f"status={status}")

    status, payload = call("GET", f"/public/blog/{slug}")
    check("B2 草稿文章公开详情 404（不泄漏存在性）", status == 404, f"status={status}")

    status, payload = call("GET", "/public/blog?pageSize=24")
    listed = [item["slug"] for item in data_of(payload).get("items", [])] if status == 200 else []
    check("B3 草稿文章不出现在公开列表", slug not in listed, f"public total={data_of(payload).get('total')}")

    # 净化验证：script 标签被剥离（注意：不能用裸 "script" 子串判断——
    # 响应中的 seoDescription / ogDescription 等字段名本身含 "script"）
    status, payload = call("GET", f"/cms/blog/posts/{post_id}", token=token)
    stored = flat(data_of(payload))
    check(
        "C1 富文本写入时净化（<script> 被剥离）",
        "<script" not in stored.lower(),
        "contentHtml 无 script 标签",
    )

    # 发布 → 公开可见
    status, payload = call(
        "PATCH", f"/cms/blog/posts/{post_id}", token=token, body={"status": "PUBLISHED"}
    )
    check("B4 文章发布成功", status < 300, f"status={status}")

    status, payload = call("GET", f"/public/blog/{slug}")
    detail = data_of(payload) if status == 200 else {}
    check("B5 已发布文章公开详情可见（200）", status == 200, f"status={status}")
    check(
        "B6 公开详情含正文 HTML 且无 script 标签",
        bool(detail.get("contentHtml")) and "<script" not in flat(detail).lower(),
    )
    leaked = [key for key in ("authorId", "createdBy", "storageKey", "status", "categoryId", "provider") if key in detail]
    check("B7 公开 DTO 白名单（无内部字段）", not leaked, f"leaked={leaked}")
    check("B8 公开详情含阅读时长与分类字段", "readingMinutes" in detail and "category" in detail)

    # 归档 → 公开不可见
    status, payload = call(
        "PATCH", f"/cms/blog/posts/{post_id}", token=token, body={"status": "ARCHIVED"}
    )
    status2, _ = call("GET", f"/public/blog/{slug}")
    check("B9 归档（ARCHIVED）后公开详情 404", status < 300 and status2 == 404, f"archive={status} public={status2}")

    # 恢复为 PUBLISHED（供浏览器验证）
    call("PATCH", f"/cms/blog/posts/{post_id}", token=token, body={"status": "PUBLISHED"})

    # ---------- H. 分页上限 ----------
    status, payload = call("GET", "/public/blog?pageSize=999")
    check("H1 公开列表 pageSize 超限被拒（400）", status == 400, f"status={status}")

    # ---------- D. 站点内容写入 → 公开读取 ----------
    status, payload = call("GET", "/cms/site/sections?page=HOME", token=token)
    hero = next(
        (item for item in data_of(payload).get("items", []) if item["sectionKey"] == "home.hero"),
        None,
    )
    check("D1 读到首页 hero 分区", hero is not None)
    original_title = hero["title"] if hero else None
    original_status = hero["status"] if hero else None
    marked_title = f"{MARK} CMS 链路验证标题"

    if hero:
        status, payload = call(
            "PATCH", f"/cms/site/sections/{hero['id']}", token=token, body={"title": marked_title}
        )
        check("D2 更新首页 hero 标题成功", status < 300, f"status={status}")

        status, payload = call("GET", "/public/site/HOME")
        public_hero = next(
            (
                item
                for item in data_of(payload).get("items", [])
                if item["sectionKey"] == "home.hero"
            ),
            None,
        )
        check(
            "D3 公开 API 立即反映 CMS 改动（写入 → 读取）",
            bool(public_hero) and public_hero.get("title") == marked_title,
            f"public title={public_hero.get('title') if public_hero else None}",
        )
        check(
            "D4 公开分区 DTO 白名单",
            not [k for k in ("id", "status", "createdBy", "sortOrder", "mediaId") if public_hero and k in public_hero],
        )

        # E. 危险协议 URL
        status, payload = call(
            "PATCH",
            f"/cms/site/sections/{hero['id']}",
            token=token,
            body={"ctaUrl": "javascript:alert(1)"},
        )
        check("E1 危险协议 ctaUrl 被拒（400）", status == 400, f"status={status}")

        status, payload = call(
            "PATCH",
            f"/cms/site/sections/{hero['id']}",
            token=token,
            body={"ctaUrl": "http://evil.example.com"},
        )
        check("E2 非 https 外链被拒（400）", status == 400, f"status={status}")

        status, payload = call(
            "PATCH",
            f"/cms/site/sections/{hero['id']}",
            token=token,
            body={"ctaUrl": "//evil.example.com"},
        )
        check("E3 协议相对 URL（//）被拒（400）", status == 400, f"status={status}")

        status, payload = call(
            "PATCH",
            f"/cms/site/sections/{hero['id']}",
            token=token,
            body={"ctaUrl": "https://bailingwooden.com/about"},
        )
        check("E4 合法 https 外链被接受", status < 300, f"status={status}")

        # 还原 ctaUrl
        call("PATCH", f"/cms/site/sections/{hero['id']}", token=token, body={"ctaUrl": "/contact#rfq"})

    # 未发布分区不可见
    new_key = f"{MARK.lower()}.draft-section"
    status, payload = call(
        "POST",
        "/cms/site/sections",
        token=token,
        body={
            "page": "HOME",
            "sectionKey": new_key,
            "title": f"{MARK} 草稿分区",
            "body": "该分区处于草稿状态，公开接口不可见。",
        },
    )
    draft_id = data_of(payload).get("id") if status < 300 else None
    check("B10 创建草稿分区成功（默认 DRAFT）", status < 300 and bool(draft_id), f"status={status}")

    status, payload = call("GET", f"/public/site/HOME/{new_key}")
    check("B11 草稿分区公开详情 404", status == 404, f"status={status}")

    status, payload = call("GET", "/public/site/HOME")
    keys = [item["sectionKey"] for item in data_of(payload).get("items", [])] if status == 200 else []
    check("B12 草稿分区不出现在公开列表", new_key not in keys)

    # 发布完整性：空标题不允许发布
    status, payload = call(
        "POST",
        "/cms/site/sections",
        token=token,
        body={"page": "ABOUT", "sectionKey": f"{MARK.lower()}.empty-section"},
    )
    empty_id = data_of(payload).get("id") if status < 300 else None
    if empty_id:
        status, payload = call(
            "PATCH", f"/cms/site/sections/{empty_id}", token=token, body={"status": "PUBLISHED"}
        )
        check("E5 空内容分区发布被拒（403）", status == 403, f"status={status}")

    # ---------- F. 导航启用过滤 ----------
    status, payload = call(
        "POST",
        "/cms/nav/items",
        token=token,
        body={
            "location": "FOOTER",
            "label": f"{MARK} 隐藏导航",
            "url": "/quality",
            "isActive": False,
            "sortOrder": 900,
        },
    )
    nav_id = data_of(payload).get("id") if status < 300 else None
    check("F1 创建停用导航项成功", status < 300 and bool(nav_id), f"status={status}")

    status, payload = call("GET", "/public/navigation?location=FOOTER")
    labels = [item["label"] for item in data_of(payload).get("items", [])] if status == 200 else []
    check("F2 停用导航项不出现在公开导航", f"{MARK} 隐藏导航" not in labels)

    if nav_id:
        call("PATCH", f"/cms/nav/items/{nav_id}", token=token, body={"isActive": True})
        status, payload = call("GET", "/public/navigation?location=FOOTER")
        labels = [item["label"] for item in data_of(payload).get("items", [])] if status == 200 else []
        check("F3 启用后出现在公开导航", f"{MARK} 隐藏导航" in labels)

        status, payload = call(
            "PATCH", f"/cms/nav/items/{nav_id}", token=token, body={"url": "javascript:alert(1)"}
        )
        check("F4 导航危险协议被拒（400）", status == 400, f"status={status}")

    # ---------- G. 媒体删除保护 ----------
    media_id = upload_media(token)
    check("G1 上传验证用素材成功", bool(media_id))
    if media_id and hero:
        # 制造引用：把素材挂到 hero 分区
        call("PATCH", f"/cms/site/sections/{hero['id']}", token=token, body={"mediaId": media_id})
        status, _ = call("DELETE", f"/cms/media/{media_id}", token=token)
        check("G2 被站点分区引用的媒体不可删除（400）", status == 400, f"status={status}")

        # 解除引用后可删除
        call("PATCH", f"/cms/site/sections/{hero['id']}", token=token, body={"mediaId": None})
        status, _ = call("DELETE", f"/cms/media/{media_id}", token=token)
        check("G3 解除引用后媒体可删除（200）", status == 200, f"status={status}")
    elif media_id:
        call("DELETE", f"/cms/media/{media_id}", token=token)

    # ---------- A. RBAC 越权 ----------
    status, payload = call("GET", "/cms/roles", token=token)
    roles = data_of(payload).get("items", []) if status == 200 else []
    editor_role = next((r for r in roles if r.get("key") == "CONTENT_EDITOR"), None)
    check("A4 读到 CONTENT_EDITOR 角色", editor_role is not None, f"roles={[r.get('key') for r in roles]}")

    # 权限增量核对：Phase 4.7 新增的 site.* 是否已授予内容编辑角色
    # （内置角色预设已包含 site.read/create/update；已存在的库需通过角色管理补齐）
    if editor_role:
        status, payload = call("GET", f"/cms/roles/{editor_role['id']}", token=token)
        keys = data_of(payload).get("permissions", []) if status == 200 else []
        check(
            "A5 CONTENT_EDITOR 已授予 site.read/create/update",
            {"site.read", "site.create", "site.update"}.issubset(set(keys)),
            f"site perms={sorted(k for k in keys if k.startswith('site'))}",
        )
        check(
            "A6 CONTENT_EDITOR 未授予 nav.*（导航管理仅超管）",
            not [k for k in keys if k.startswith("nav.")],
        )

    editor_created = False
    editor_id = None
    if editor_role:
        status, payload = call(
            "POST",
            "/cms/accounts",
            token=token,
            body={
                "name": "Phase47 Verify Editor",
                "email": EDITOR_EMAIL,
                "jobTitle": "Verification account",
                "roleIds": [editor_role["id"]],
                "initialPassword": EDITOR_PASSWORD,
                "isActive": True,
            },
        )
        editor_created = status < 300
        editor_id = data_of(payload).get("id") if editor_created else None
        if not editor_created:
            # 已存在（上次运行残留）：查出来复用
            status, payload = call(
                "GET", f"/cms/accounts?limit=100&keyword={EDITOR_EMAIL}", token=token
            )
            users = data_of(payload).get("items", []) if status == 200 else []
            target = next((u for u in users if u.get("email") == EDITOR_EMAIL), None)
            if target:
                editor_id = target["id"]
                editor_created = True
                # 复用前确保处于启用状态与正确口令（口令可能已被上轮重置）
                call(
                    "PATCH",
                    f"/cms/accounts/{editor_id}/status",
                    token=token,
                    body={"isActive": True},
                )
                call(
                    "POST",
                    f"/cms/accounts/{editor_id}/reset-password",
                    token=token,
                    body={"newPassword": EDITOR_PASSWORD},
                )
        check("A7 创建 / 复用 CONTENT_EDITOR 测试账号", editor_created, f"status={status}")

    if editor_created:
        status, payload = call(
            "POST", "/auth/login", body={"email": EDITOR_EMAIL, "password": EDITOR_PASSWORD}
        )
        editor_token = data_of(payload).get("accessToken") if status < 300 else None
        check("A8 编辑者账号登录成功", bool(editor_token), f"status={status}")

        if editor_token:
            status, _ = call("GET", "/cms/site/sections", token=editor_token)
            check("A9 编辑者具备 site.read（200）", status == 200, f"status={status}")

            status, _ = call("GET", "/cms/accounts", token=editor_token)
            check("A10 编辑者无 accounts.read，越权被拒（403）", status == 403, f"status={status}")

            if draft_id:
                status, _ = call("DELETE", f"/cms/site/sections/{draft_id}", token=editor_token)
                check("A11 编辑者无 site.delete，越权被拒（403）", status == 403, f"status={status}")

            status, _ = call(
                "POST",
                "/cms/nav/items",
                token=editor_token,
                body={"location": "HEADER", "label": "越权导航", "url": "/quality"},
            )
            check("A12 编辑者无 nav.create，越权被拒（403）", status == 403, f"status={status}")

            status, _ = call("DELETE", f"/cms/blog/posts/{post_id}", token=editor_token)
            check("A13 编辑者无 blog.delete，越权被拒（403）", status == 403, f"status={status}")

            status, _ = call("GET", "/cms/roles", token=editor_token)
            check("A14 编辑者无 roles.read，越权被拒（403）", status == 403, f"status={status}")

    # ---------- 清理 ----------
    print("-" * 78)
    if hero and original_title is not None:
        call("PATCH", f"/cms/site/sections/{hero['id']}", token=token, body={"title": original_title})
        print(f"      note: 首页 hero 标题已还原为原始值（status 保持 {original_status}）")
    if post_id:
        call("DELETE", f"/cms/blog/posts/{post_id}", token=token)
    if draft_id:
        call("DELETE", f"/cms/site/sections/{draft_id}", token=token)
    if empty_id:
        call("DELETE", f"/cms/site/sections/{empty_id}", token=token)
    if nav_id:
        call("DELETE", f"/cms/nav/items/{nav_id}", token=token)
    if editor_id:
        status, _ = call("PATCH", f"/cms/accounts/{editor_id}/status", token=token, body={"isActive": False})
        print(f"      note: 测试账号 {EDITOR_EMAIL} 已停用（id={editor_id}），如需彻底移除请执行：")
        print(f"            docker exec bailing-postgres psql -U bailing -d bailingwooden -c \\")
        print(f"              \"delete from admin_users where email='{EDITOR_EMAIL}';\"")

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print("=" * 78)
    print(f"结果：{passed}/{total} 通过")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL: {name} {detail}")
    print("=" * 78)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
