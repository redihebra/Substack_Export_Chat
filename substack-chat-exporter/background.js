// Substack Chat Exporter - Background Service Worker (PATCHED v2)
// Fixes:
//  1. onProgress now fires during BFS, so popup never appears stuck at 541.
//  2. Keep-alive: periodic chrome.runtime.getPlatformInfo() pings prevent the
//     MV3 service worker from being terminated mid-export.
//  3. Progress messages tolerate a closed popup (no Promise rejection on send).
//  4. Comments are deduplicated by id before tree-building (Substack's pagination
//     can return the same comment twice at page boundaries).
//  5. Download uses a base64 data: URI — MV3 service workers do NOT have
//     URL.createObjectURL, so blob URLs are not an option. Base64 keeps the
//     URL compact (no percent-encoding bloat) and works for any text size.

function fmtTime(ts) {
  if (!ts) return "unknown";
  try {
    const dt = new Date(ts);
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    const h = String(dt.getUTCHours()).padStart(2, "0");
    const mi = String(dt.getUTCMinutes()).padStart(2, "0");
    return `${y}-${mo}-${d} ${h}:${mi} UTC`;
  } catch {
    return ts;
  }
}

// ---- Keep-alive ----------------------------------------------------------
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ---- Safe progress message ----------------------------------------------
function safeSend(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {});
  } catch {}
}

// ---- API calls -----------------------------------------------------------
async function fetchComments(postId, cookie, after) {
  const params = ["order=asc"];
  if (after) params.push(`after=${encodeURIComponent(after)}`);
  const url = `https://substack.com/api/v1/community/posts/${postId}/comments?${params.join("&")}`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
      Cookie: `substack.sid=${cookie}`,
      Referer: "https://substack.com/chat/",
    },
  });

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("Session expired. Please log in to Substack again.");
    }
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

async function fetchChildComments(commentId, cookie) {
  const allChildren = [];
  const url = `https://substack.com/api/v1/community/comments/${commentId}/comments`;
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "application/json",
    Cookie: `substack.sid=${cookie}`,
    Referer: "https://substack.com/chat/",
  };

  let resp;
  try {
    resp = await fetch(url, { headers });
    if (!resp.ok) return [];
  } catch {
    return [];
  }

  let data = await resp.json();
  let replies = data.replies || [];
  allChildren.push(...replies);

  while (data.moreAfter || data.more) {
    if (!replies.length) break;
    const lastTs = replies[replies.length - 1].comment.created_at;
    await new Promise((r) => setTimeout(r, 500));
    try {
      resp = await fetch(`${url}?after=${encodeURIComponent(lastTs)}`, {
        headers,
      });
      if (!resp.ok) break;
    } catch {
      break;
    }
    data = await resp.json();
    replies = data.replies || [];
    if (!replies.length) break;
    allChildren.push(...replies);
  }
  return allChildren;
}

async function fetchAllComments(postId, cookie, onProgress) {
  const allReplies = [];
  let postInfo = null;

  // ---- Phase 1: top-level pagination ----
  let data = await fetchComments(postId, cookie);
  if (data.post) postInfo = data.post;
  let replies = data.replies || [];
  allReplies.push(...replies);
  let page = 1;
  onProgress({ phase: "top", page, totalReplies: allReplies.length });

  while (data.moreAfter || data.more) {
    if (!replies.length) break;
    const lastTs = replies[replies.length - 1].comment.created_at;
    await new Promise((r) => setTimeout(r, 500));
    data = await fetchComments(postId, cookie, lastTs);
    replies = data.replies || [];
    if (!replies.length) break;
    allReplies.push(...replies);
    page++;
    onProgress({ phase: "top", page, totalReplies: allReplies.length });
  }

  // ---- Phase 2: BFS for nested replies ----
  const queue = [];
  const seen = new Set();
  for (const r of allReplies) {
    if ((r.comment.reply_count || 0) > 0) queue.push(r.comment.id);
  }
  const totalParents = queue.length;
  let processed = 0;
  onProgress({
    phase: "nested",
    page: 0,
    totalReplies: allReplies.length,
    processed,
    totalParents,
  });

  while (queue.length > 0) {
    const commentId = queue.shift();
    if (seen.has(commentId)) continue;
    seen.add(commentId);
    processed++;

    await new Promise((r) => setTimeout(r, 500));
    const children = await fetchChildComments(commentId, cookie);
    if (children.length > 0) {
      allReplies.push(...children);
      for (const r of children) {
        if ((r.comment.reply_count || 0) > 0 && !seen.has(r.comment.id)) {
          queue.push(r.comment.id);
        }
      }
    }
    onProgress({
      phase: "nested",
      page: 0,
      totalReplies: allReplies.length,
      processed,
      totalParents,
    });
  }

  return { postInfo, allReplies };
}

// ---- Tree building & rendering ------------------------------------------
function buildTree(replies) {
  const seenIds = new Set();
  const deduped = [];
  for (const r of replies) {
    if (!seenIds.has(r.comment.id)) {
      seenIds.add(r.comment.id);
      deduped.push(r);
    }
  }

  const byId = new Map();
  const roots = [];

  for (const r of deduped) {
    byId.set(r.comment.id, { comment: r.comment, user: r.user || {}, children: [] });
  }
  for (const r of deduped) {
    const parentId = r.comment.parent_id;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId).children.push(byId.get(r.comment.id));
    } else {
      roots.push(byId.get(r.comment.id));
    }
  }
  return roots;
}

function renderMd(node, depth = 0) {
  const lines = [];
  const c = node.comment;
  const u = node.user || {};
  const name = u.name || "Unknown";
  const handle = u.handle || "";
  const ts = fmtTime(c.created_at);
  const body = (c.body || "").trim();

  if (depth === 0) {
    lines.push(`### ${name} (@${handle})`);
    lines.push(`*${ts}*`);
    lines.push("");
    lines.push(body);
    const reactions = c.reactions;
    if (reactions && Object.keys(reactions).length > 0) {
      const parts = Object.entries(reactions).map(([k, v]) => `${k}:${v}`).join(" ");
      lines.push(`\n*Reactions: ${parts}*`);
    }
  } else {
    const indent = "> ".repeat(depth);
    lines.push(`${indent}**${name}** (@${handle}) — *${ts}*`);
    lines.push(indent);
    for (const bline of body.split("\n")) lines.push(`${indent}${bline}`);
  }
  lines.push("");
  for (const child of node.children) lines.push(...renderMd(child, depth + 1));
  if (depth === 0) {
    lines.push("---");
    lines.push("");
  }
  return lines;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 60);
}

function buildMarkdown(postInfo, allReplies) {
  const lines = [];
  if (postInfo) {
    const cp = postInfo.communityPost || {};
    const user = postInfo.user || {};
    const body = cp.body || "Chat Thread";
    const firstLine = body.split("\n")[0].substring(0, 100);
    lines.push(`# Substack Chat: ${firstLine}`);
    lines.push("");
    lines.push(`**Author:** ${user.name || "Unknown"} (@${user.handle || ""})`);
    lines.push(`**Created:** ${fmtTime(cp.created_at)}`);
    lines.push(`**Total replies:** ${cp.comment_count || allReplies.length}`);
    lines.push("");
    lines.push("## Original Post");
    lines.push("");
    lines.push(body);
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## Replies");
    lines.push("");
  }
  const tree = buildTree(allReplies);
  for (const node of tree) lines.push(...renderMd(node));
  return lines.join("\n");
}

function getFilename(postInfo) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let slug = "thread";
  if (postInfo) {
    const cp = postInfo.communityPost || {};
    const body = cp.body || "";
    const firstLine = body.split("\n")[0].substring(0, 100);
    if (firstLine) slug = slugify(firstLine);
  }
  return `substack-chat-${slug}-${date}.md`;
}

// ---- UTF-8 -> base64 (safe for any Unicode text) -------------------------
// btoa() throws on non-Latin1 characters. We encode the string as UTF-8
// bytes first, then base64-encode those bytes via btoa-on-binary-string.
function utf8ToBase64(str) {
  // TextEncoder is available in MV3 service workers.
  const bytes = new TextEncoder().encode(str);
  // Build a binary string in chunks to avoid call-stack limits on large inputs.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize)
    );
  }
  return btoa(binary);
}

// ---- Message handler -----------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "export") {
    handleExport(message.postId);
  }
  return false;
});

async function handleExport(postId) {
  startKeepAlive();
  try {
    const cookie = await chrome.cookies.get({
      url: "https://substack.com",
      name: "substack.sid",
    });
    if (!cookie) {
      safeSend({
        action: "error",
        message: "Please log in to Substack first. No session cookie found.",
      });
      stopKeepAlive();
      return;
    }
    const cookieValue = cookie.value;

    const { postInfo, allReplies } = await fetchAllComments(
      postId,
      cookieValue,
      (info) => {
        safeSend({
          action: "progress",
          page: info.page,
          totalReplies: info.totalReplies,
          phase: info.phase,
          processed: info.processed,
          totalParents: info.totalParents,
        });
      }
    );

    const markdown = buildMarkdown(postInfo, allReplies);
    const filename = getFilename(postInfo);

    // Build a base64 data: URI. Service workers cannot use URL.createObjectURL,
    // so this is the supported way to feed in-memory text to chrome.downloads.
    const b64 = utf8ToBase64(markdown);
    const dataUrl = `data:text/markdown;charset=utf-8;base64,${b64}`;

    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          safeSend({
            action: "error",
            message: chrome.runtime.lastError.message,
          });
        } else if (downloadId === undefined) {
          safeSend({
            action: "error",
            message: "Download did not start (no downloadId returned).",
          });
        } else {
          safeSend({
            action: "complete",
            filename,
            replyCount: allReplies.length,
          });
        }
        stopKeepAlive();
      }
    );
  } catch (err) {
    stopKeepAlive();
    safeSend({
      action: "error",
      message: err.message || "Unknown error occurred",
    });
  }
}
