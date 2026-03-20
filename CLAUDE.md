# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A single-file Python script (`substack_chat_export.py`) that exports Substack chat threads to markdown. It uses only the Python standard library (no dependencies to install).

## Running

```bash
python substack_chat_export.py
python substack_chat_export.py --cookie "YOUR_COOKIE" --post-id "UUID" --output "output.md"
```

Config can be set via CLI args (`--cookie`, `--post-id`, `--output`) or by editing the values at the top of the script. CLI args take precedence.

## Architecture

The script paginates through the Substack community comments API (`/api/v1/community/posts/{id}/comments`), builds a tree structure from flat reply data using parent_id references, then renders the tree as nested markdown with blockquote indentation for thread depth. Pagination uses the `after` parameter with the last comment's timestamp.

Key functions:
- `fetch_all_comments()` — paginated API fetcher with 0.5s rate limiting
- `build_tree()` — converts flat reply list into parent-child tree via `parent_id` lookup
- `render_md()` — recursive markdown renderer using `> ` blockquote nesting for reply depth

## Cowork Skill

A `/substack-export` skill is available at `~/.claude/skills/substack-export.md` for use in cowork mode. It navigates Chrome to a Substack community, finds the target thread, and exports it using browser-side JavaScript (no cookie extraction needed — the browser handles auth automatically). Requires being logged into Substack in Chrome.

## Important Notes

- The `COOKIE` value in the script is a real session token. Never commit fresh credentials. The current value is likely expired.
- No third-party dependencies — uses only `urllib` and standard library modules.
