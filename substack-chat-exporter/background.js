// Substack Chat Exporter - Background Service Worker
// Direct port of substack_chat_export.py logic

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

async function fetchComments(postId, cookie, after) {
  const params = ["order=asc"];
  if (after) {
    params.push(`after=${encodeURIComponent(after)}`);
  }
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

  // Paginate if needed
  while (data.moreAfter || data.more) {
    if (!replies.length) break;
    const lastTs = replies[replies.length - 1].comment.created_at;

    await new Promise((r) => setTimeout(r, 500));
    try {
      resp = await fetch(
        `${url}?after=${encodeURIComponent(lastTs)}`,
        { headers }
      );
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

  let data = await fetchComments(postId, cookie);

  if (data.post) {
    postInfo = data.post;
  }

  let replies = data.replies || [];
  allReplies.push(...replies);
  let page = 1;
  onProgress(page, allReplies.length);

  while (data.moreAfter || data.more) {
    if (!replies.length) break;
    const lastTs = replies[replies.length - 1].comment.created_at;

    await new Promise((r) => setTimeout(r, 500));
    data = await fetchComments(postId, cookie, lastTs);
    replies = data.replies || [];

    if (!replies.length) break;

    allReplies.push(...replies);
    page++;
    onProgress(page, allReplies.length);
  }

  // Fetch nested replies (replies to replies) via BFS
  const queue = [];
  const seen = new Set();

  for (const r of allReplies) {
    const c = r.comment;
    if ((c.reply_count || 0) > 0) {
      queue.push(c.id);
    }
  }

  while (queue.length > 0) {
    const commentId = queue.shift();
    if (seen.has(commentId)) continue;
    seen.add(commentId);

    await new Promise((r) => setTimeout(r, 500));
    const children = await fetchChildComments(commentId, cookie);
    if (children.length > 0) {
      allReplies.push(...children);
      // Check if any children also have children
      for (const r of children) {
        const c = r.comment;
        if ((c.reply_count || 0) > 0 && !seen.has(c.id)) {
          queue.push(c.id);
        }
      }
    }
  }

  return { postInfo, allReplies };
}

function buildTree(replies) {
  const byId = new Map();
  const roots = [];

  for (const r of replies) {
    const c = r.comment;
    byId.set(c.id, { comment: c, user: r.user || {}, children: [] });
  }

  for (const r of replies) {
    const c = r.comment;
    const parentId = c.parent_id;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId).children.push(byId.get(c.id));
    } else {
      roots.push(byId.get(c.id));
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
      const parts = Object.entries(reactions)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      lines.push(`\n*Reactions: ${parts}*`);
    }
  } else {
    const indent = "> ".repeat(depth);
    lines.push(`${indent}**${name}** (@${handle}) — *${ts}*`);
    lines.push(indent);
    for (const bline of body.split("\n")) {
      lines.push(`${indent}${bline}`);
    }
  }

  lines.push("");

  for (const child of node.children) {
    lines.push(...renderMd(child, depth + 1));
  }

  if (depth === 0) {
    lines.push("---");
    lines.push("");
  }

  return lines;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60);
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
    lines.push(
      `**Author:** ${user.name || "Unknown"} (@${user.handle || ""})`
    );
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
  for (const node of tree) {
    lines.push(...renderMd(node));
  }

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
    if (firstLine) {
      slug = slugify(firstLine);
    }
  }

  return `substack-chat-${slug}-${date}.md`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "export") {
    handleExport(message.postId);
  }
  return false;
});

async function handleExport(postId) {
  try {
    // Get cookie
    const cookie = await chrome.cookies.get({
      url: "https://substack.com",
      name: "substack.sid",
    });

    if (!cookie) {
      chrome.runtime.sendMessage({
        action: "error",
        message: "Please log in to Substack first. No session cookie found.",
      });
      return;
    }

    const cookieValue = cookie.value;

    // Fetch all comments with progress
    const { postInfo, allReplies } = await fetchAllComments(
      postId,
      cookieValue,
      (page, total) => {
        chrome.runtime.sendMessage({
          action: "progress",
          page,
          totalReplies: total,
        });
      }
    );

    // Build markdown
    const markdown = buildMarkdown(postInfo, allReplies);
    const filename = getFilename(postInfo);

    // Download
    const dataUrl =
      "data:text/markdown;charset=utf-8," + encodeURIComponent(markdown);
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: filename,
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          chrome.runtime.sendMessage({
            action: "error",
            message: chrome.runtime.lastError.message,
          });
        } else {
          chrome.runtime.sendMessage({
            action: "complete",
            filename,
            replyCount: allReplies.length,
          });
        }
      }
    );
  } catch (err) {
    chrome.runtime.sendMessage({
      action: "error",
      message: err.message || "Unknown error occurred",
    });
  }
}
