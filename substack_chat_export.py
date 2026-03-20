#!/usr/bin/env python3
"""
Substack Chat Thread Exporter - Simple Version
Just edit the two values below and run: python substack_chat_export.py
"""

# ============================================================
# EDIT THESE TWO VALUES:
# ============================================================

# Your substack.sid cookie (from DevTools > Application > Cookies > substack.sid, with "show url-decoded" checked)
COOKIE = "PASTE_YOUR_COOKIE_HERE"

# The chat post UUID (from the chat URL: https://substack.com/chat/312411/post/<THIS-PART>)
POST_ID = "7738e0ff-4d8f-4310-9a9c-a94c3a35dc0e"

# Output filename
OUTPUT_FILE = "chat_export.md"

# ============================================================
# Don't edit below here
# ============================================================

import argparse
import json
import sys
import time
from collections import deque
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import quote


def fetch_comments(post_id, cookie, after=None):
    base_url = f"https://substack.com/api/v1/community/posts/{post_id}/comments"
    params = ["order=asc"]
    if after:
        params.append(f"after={quote(after)}")

    url = f"{base_url}?{'&'.join(params)}"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Cookie": f"substack.sid={cookie}",
        "Referer": "https://substack.com/chat/",
    }

    req = Request(url, headers=headers)
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        print(f"\nERROR: HTTP {e.code} - {e.reason}")
        if e.code in (401, 403):
            print(">> Your cookie is invalid or expired. Get a fresh one from DevTools.")
        body = e.read().decode("utf-8", errors="replace")
        print(f">> Response: {body[:300]}")
        sys.exit(1)
    except URLError as e:
        print(f"\nERROR: {e.reason}")
        sys.exit(1)


def fetch_child_comments(comment_id, cookie):
    """Fetch nested replies for a specific comment via BFS with pagination."""
    all_children = []
    url = f"https://substack.com/api/v1/community/comments/{comment_id}/comments"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Cookie": f"substack.sid={cookie}",
        "Referer": "https://substack.com/chat/",
    }

    try:
        req = Request(url, headers=headers)
        with urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (HTTPError, URLError):
        return []

    replies = data.get("replies", [])
    all_children.extend(replies)

    # Paginate if needed
    while data.get("moreAfter", False) or data.get("more", False):
        if not replies:
            break
        last_ts = replies[-1]["comment"]["created_at"]
        time.sleep(0.5)
        try:
            paged_url = f"{url}?after={quote(last_ts)}"
            req = Request(paged_url, headers=headers)
            with urlopen(req) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (HTTPError, URLError):
            break
        replies = data.get("replies", [])
        if not replies:
            break
        all_children.extend(replies)

    return all_children


def fetch_all_comments(post_id, cookie):
    all_replies = []
    post_info = None

    print("Fetching comments...")
    data = fetch_comments(post_id, cookie)

    if "post" in data:
        post_info = data["post"]

    replies = data.get("replies", [])
    all_replies.extend(replies)
    print(f"  Page 1: got {len(replies)} replies")

    page = 1
    while data.get("moreAfter", False) or data.get("more", False):
        if not replies:
            break
        last_ts = replies[-1]["comment"]["created_at"]

        time.sleep(0.5)
        data = fetch_comments(post_id, cookie, after=last_ts)
        replies = data.get("replies", [])

        if not replies:
            break

        all_replies.extend(replies)
        page += 1
        print(f"  Page {page}: got {len(replies)} replies (total: {len(all_replies)})")

    # Fetch nested replies (replies to replies) via BFS
    queue = deque()
    seen = set()
    for r in all_replies:
        c = r["comment"]
        if c.get("reply_count", 0) > 0:
            queue.append(c["id"])

    if queue:
        print(f"Fetching nested replies for {len(queue)} comments...")

    while queue:
        comment_id = queue.popleft()
        if comment_id in seen:
            continue
        seen.add(comment_id)

        time.sleep(0.5)
        children = fetch_child_comments(comment_id, cookie)
        if children:
            all_replies.extend(children)
            print(f"  Got {len(children)} nested replies")
            # Check if any children also have children
            for r in children:
                c = r["comment"]
                if c.get("reply_count", 0) > 0 and c["id"] not in seen:
                    queue.append(c["id"])

    print(f"Done! Total replies (including nested): {len(all_replies)}")
    return post_info, all_replies


def fmt_time(ts):
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except:
        return ts or "unknown"


def build_tree(replies):
    by_id = {}
    roots = []

    for r in replies:
        c = r["comment"]
        by_id[c["id"]] = {"comment": c, "user": r.get("user", {}), "children": []}

    for r in replies:
        c = r["comment"]
        parent = c.get("parent_id")
        if parent and parent in by_id:
            by_id[parent]["children"].append(by_id[c["id"]])
        else:
            roots.append(by_id[c["id"]])

    return roots


def render_md(node, depth=0):
    lines = []
    c = node["comment"]
    u = node.get("user", {})
    name = u.get("name", "Unknown")
    handle = u.get("handle", "")
    ts = fmt_time(c.get("created_at"))
    body = (c.get("body") or "").strip()

    if depth == 0:
        lines.append(f"### {name} (@{handle})")
        lines.append(f"*{ts}*")
        lines.append("")
        lines.append(body)
        reactions = c.get("reactions", {})
        if reactions:
            lines.append(f"\n*Reactions: {' '.join(f'{k}:{v}' for k,v in reactions.items())}*")
    else:
        indent = "> " * depth
        lines.append(f"{indent}**{name}** (@{handle}) — *{ts}*")
        lines.append(f"{indent}")
        for bline in body.split("\n"):
            lines.append(f"{indent}{bline}")

    lines.append("")

    for child in node.get("children", []):
        lines.extend(render_md(child, depth + 1))

    if depth == 0:
        lines.append("---")
        lines.append("")

    return lines


def main():
    parser = argparse.ArgumentParser(description="Export Substack chat thread to markdown")
    parser.add_argument("--cookie", help="substack.sid cookie value")
    parser.add_argument("--post-id", help="Chat post UUID")
    parser.add_argument("--output", "-o", help="Output filename")
    args = parser.parse_args()

    cookie = args.cookie or COOKIE
    post_id = getattr(args, "post_id") or POST_ID
    output_file = args.output or OUTPUT_FILE

    if cookie == "PASTE_YOUR_COOKIE_HERE":
        print("ERROR: You need to provide your substack.sid cookie value!")
        print("Either pass --cookie on the command line or edit the value at the top of this file.")
        sys.exit(1)

    post_info, replies = fetch_all_comments(post_id, cookie)

    lines = []

    if post_info:
        cp = post_info.get("communityPost", {})
        user = post_info.get("user", {})
        body = cp.get("body", "Chat Thread")
        first_line = body.split("\n")[0][:100]

        lines.append(f"# Substack Chat: {first_line}")
        lines.append("")
        lines.append(f"**Author:** {user.get('name', 'Unknown')} (@{user.get('handle', '')})")
        lines.append(f"**Created:** {fmt_time(cp.get('created_at'))}")
        lines.append(f"**Total replies:** {cp.get('comment_count', len(replies))}")
        lines.append("")
        lines.append("## Original Post")
        lines.append("")
        lines.append(body)
        lines.append("")
        lines.append("---")
        lines.append("")
        lines.append("## Replies")
        lines.append("")

    tree = build_tree(replies)
    for node in tree:
        lines.extend(render_md(node))

    markdown = "\n".join(lines)

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(markdown)

    print(f"\nExported to {output_file}")


if __name__ == "__main__":
    main()
