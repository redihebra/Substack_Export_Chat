---
name: substack-export
description: Export a Substack chat thread to markdown via Chrome browser. Navigates to the community, finds the thread, and exports all replies including nested threads.
---

# Substack Chat Export

Export a Substack chat thread to a markdown file. Requires the user to be logged into Substack in Chrome.

## Community Lookup Table

Use this mapping to resolve community names to URLs. The user will refer to communities by short name.

```
macrotourist → https://substack.com/chat/20439
campbell → https://substack.com/chat/312411
shrub → https://substack.com/chat/1476543
paulomacro → https://substack.com/chat/2195305
dannyd → https://substack.com/chat/2360679
```

If the user mentions a community not in this table, ask them for the URL.

## Workflow

### Step 1: Identify the Target Thread

The user will either:
- Provide a direct chat URL (e.g., `https://substack.com/chat/312411/post/<uuid>`)
- Describe which thread they want (e.g., "the latest thread from macrotourist")

If they provide a direct URL, extract the POST_ID (UUID) from it and skip to Step 3.

### Step 2: Navigate and Find the Thread

1. Use `mcp__Claude_in_Chrome__tabs_context_mcp` to get available tabs
2. Use `mcp__Claude_in_Chrome__navigate` to go to the community chat URL from the lookup table
3. Use `mcp__Claude_in_Chrome__computer` with `action: "screenshot"` to see the thread list
4. Use `mcp__Claude_in_Chrome__find` or `mcp__Claude_in_Chrome__read_page` to identify the target thread
5. Use `mcp__Claude_in_Chrome__computer` with `action: "left_click"` and the element ref to open the thread
6. Use `mcp__Claude_in_Chrome__javascript_tool` to get the URL and extract the POST_ID:
   ```javascript
   window.location.href.match(/\/post\/([0-9a-f-]{36})/i)?.[1]
   ```

### Step 3: Export via Browser JavaScript

Inject this JavaScript payload via `mcp__Claude_in_Chrome__javascript_tool`. Replace `POST_ID_HERE` with the actual UUID, and `COMMUNITY_NAME_HERE` with the lookup table key (e.g., "macrotourist").

The browser automatically includes the session cookie on same-origin fetch requests, so no cookie extraction is needed.

```javascript
(async () => {
  const POST_ID = 'POST_ID_HERE';
  const COMMUNITY = 'COMMUNITY_NAME_HERE';

  function fmtTime(ts) {
    if (!ts) return 'unknown';
    try {
      const dt = new Date(ts);
      const y = dt.getUTCFullYear();
      const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      const h = String(dt.getUTCHours()).padStart(2, '0');
      const mi = String(dt.getUTCMinutes()).padStart(2, '0');
      return `${y}-${mo}-${d} ${h}:${mi} UTC`;
    } catch { return ts; }
  }

  async function fetchComments(postId, after) {
    const params = ['order=asc'];
    if (after) params.push(`after=${encodeURIComponent(after)}`);
    const url = `https://substack.com/api/v1/community/posts/${postId}/comments?${params.join('&')}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'include'
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403)
        throw new Error('Session expired. Please log in to Substack again.');
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    return resp.json();
  }

  async function fetchChildComments(commentId) {
    const allChildren = [];
    const url = `https://substack.com/api/v1/community/comments/${commentId}/comments`;
    let resp;
    try {
      resp = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (!resp.ok) return [];
    } catch { return []; }
    let data = await resp.json();
    let replies = data.replies || [];
    allChildren.push(...replies);
    while (data.moreAfter || data.more) {
      if (!replies.length) break;
      const lastTs = replies[replies.length - 1].comment.created_at;
      await new Promise(r => setTimeout(r, 500));
      try {
        resp = await fetch(`${url}?after=${encodeURIComponent(lastTs)}`, {
          headers: { Accept: 'application/json' }, credentials: 'include'
        });
        if (!resp.ok) break;
      } catch { break; }
      data = await resp.json();
      replies = data.replies || [];
      if (!replies.length) break;
      allChildren.push(...replies);
    }
    return allChildren;
  }

  async function fetchAllComments(postId) {
    const allReplies = [];
    let postInfo = null;
    let data = await fetchComments(postId);
    if (data.post) postInfo = data.post;
    let replies = data.replies || [];
    allReplies.push(...replies);

    while (data.moreAfter || data.more) {
      if (!replies.length) break;
      const lastTs = replies[replies.length - 1].comment.created_at;
      await new Promise(r => setTimeout(r, 500));
      data = await fetchComments(postId, lastTs);
      replies = data.replies || [];
      if (!replies.length) break;
      allReplies.push(...replies);
    }

    // BFS for nested replies
    const queue = [];
    const seen = new Set();
    for (const r of allReplies) {
      if ((r.comment.reply_count || 0) > 0) queue.push(r.comment.id);
    }
    while (queue.length > 0) {
      const commentId = queue.shift();
      if (seen.has(commentId)) continue;
      seen.add(commentId);
      await new Promise(r => setTimeout(r, 500));
      const children = await fetchChildComments(commentId);
      if (children.length > 0) {
        allReplies.push(...children);
        for (const r of children) {
          if ((r.comment.reply_count || 0) > 0 && !seen.has(r.comment.id))
            queue.push(r.comment.id);
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
    const name = u.name || 'Unknown';
    const handle = u.handle || '';
    const ts = fmtTime(c.created_at);
    const body = (c.body || '').trim();
    if (depth === 0) {
      lines.push(`### ${name} (@${handle})`);
      lines.push(`*${ts}*`);
      lines.push('');
      lines.push(body);
      const reactions = c.reactions;
      if (reactions && Object.keys(reactions).length > 0) {
        const parts = Object.entries(reactions).map(([k, v]) => `${k}:${v}`).join(' ');
        lines.push(`\n*Reactions: ${parts}*`);
      }
    } else {
      const indent = '> '.repeat(depth);
      lines.push(`${indent}**${name}** (@${handle}) — *${ts}*`);
      lines.push(indent);
      for (const bline of body.split('\n')) {
        lines.push(`${indent}${bline}`);
      }
    }
    lines.push('');
    for (const child of node.children) {
      lines.push(...renderMd(child, depth + 1));
    }
    if (depth === 0) {
      lines.push('---');
      lines.push('');
    }
    return lines;
  }

  // Run the export
  const { postInfo, allReplies } = await fetchAllComments(POST_ID);

  // Build markdown
  const lines = [];
  if (postInfo) {
    const cp = postInfo.communityPost || {};
    const user = postInfo.user || {};
    const body = cp.body || 'Chat Thread';
    const firstLine = body.split('\n')[0].substring(0, 100);
    lines.push(`# Substack Chat: ${firstLine}`);
    lines.push('');
    lines.push(`**Author:** ${user.name || 'Unknown'} (@${user.handle || ''})`);
    lines.push(`**Created:** ${fmtTime(cp.created_at)}`);
    lines.push(`**Total replies:** ${cp.comment_count || allReplies.length}`);
    lines.push('');
    lines.push('## Original Post');
    lines.push('');
    lines.push(body);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Replies');
    lines.push('');
  }
  const tree = buildTree(allReplies);
  for (const node of tree) {
    lines.push(...renderMd(node));
  }
  const markdown = lines.join('\n');

  // Build filename: YYMMDD_community.md
  let threadDate = 'unknown';
  if (postInfo) {
    const cp = postInfo.communityPost || {};
    const dt = new Date(cp.created_at);
    const yy = String(dt.getUTCFullYear()).slice(2);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    threadDate = `${yy}${mm}${dd}`;
  }
  const filename = `${threadDate}_${COMMUNITY}.md`;

  return JSON.stringify({
    markdown,
    filename,
    replyCount: allReplies.length,
    title: postInfo ? (postInfo.communityPost?.body || '').split('\n')[0].substring(0, 100) : 'Chat Thread'
  });
})()
```

### Step 4: Save the File

Parse the JSON result from the JavaScript. Use the Bash tool to write the markdown content to `~/Downloads/<filename>`. The filename is already in YYMMDD_community.md format. Overwrite if the file already exists.

```bash
cat > ~/Downloads/<filename> << 'ENDOFMARKDOWN'
<markdown content here>
ENDOFMARKDOWN
```

### Step 5: Report

Tell the user:
- The filename and location (~/Downloads/)
- The thread title
- The number of replies exported

## Error Handling

- If `javascript_tool` returns an auth error (401/403), tell the user to log into Substack in Chrome and try again.
- If the thread has too many replies and the JS payload times out, inform the user and suggest they use the Chrome extension or Python script directly.
- If the community name isn't in the lookup table, ask the user for the URL.
