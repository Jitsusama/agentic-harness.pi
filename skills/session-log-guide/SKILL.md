---
name: session-log-guide
description: >
  Pi session log format and extraction patterns. How to find
  session files, parse the JSONL structure, and extract user
  messages, tool calls, and errors. Use when analyzing past
  pi sessions or debugging session behaviour.
---

# Pi Session Logs

## Format Reference

Read `docs/session.md` from the pi docs directory (listed
in the system prompt under "Pi documentation, Additional
docs"). That file documents the JSONL format, entry types,
message roles, content blocks, and tree structure.

Read it before writing any extraction code. Don't guess
the format.

## Finding Sessions

Session logs live at `~/.pi/agent/sessions/`. Each
directory encodes the project's working directory with
`--` delimiters and `/` replaced by `-`:

```
~/.pi/agent/sessions/--Users-name-src-github.com-org-repo--/
```

To find sessions for a project, list the directory.
Don't search the filesystem with `find`.

```bash
ls -lt ~/.pi/agent/sessions/--*repo-name*--/
```

Files are named `{timestamp}_{uuid}.jsonl`. Use `ls -lt`
to find the most recent.

## Older Logs, on Drive

Where core.nix's session-backup runs, a log is deleted from
the machine 90 days after its last write, once Drive holds
its sealed copy. The backup keeps one row per log it sent in
`~/.local/state/session-backup/index.jsonl`: `name` (the
Drive object), `id`, `folder`, `started`, `ended`, `title`,
`quest`, `models`, `turns`, `cost` and `bytes`. Read the index
to pick the sessions you need, then read each one back:

```bash
session-backup fetch NAME --to "$TMPDIR/log.jsonl"
```

Delete each copy once it's read; copies don't outlive the
work. `session-backup status` says how many logs still have no
row. In TypeScript, `lib/internal/session-logs.ts` does all
of this for a span.

## Extraction Approach

After reading the format docs, write a single Python
script that extracts what you need. Don't iterate with
multiple scripts trying different structures.

Common extraction targets:
- **User messages**: role `user`, text content blocks
- **Tool calls**: role `assistant`, toolCall content blocks
- **Errors**: role `toolResult` with `isError: true`
- **Full flow**: all roles interleaved chronologically
