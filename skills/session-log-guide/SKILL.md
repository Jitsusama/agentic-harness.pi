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
in the system prompt under "Pi documentation — Additional
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

## Extraction Approach

After reading the format docs, write a single Python
script that extracts what you need. Don't iterate with
multiple scripts trying different structures.

Common extraction targets:
- **User messages**: role `user`, text content blocks
- **Tool calls**: role `assistant`, toolCall content blocks
- **Errors**: role `toolResult` with `isError: true`
- **Full flow**: all roles interleaved chronologically
