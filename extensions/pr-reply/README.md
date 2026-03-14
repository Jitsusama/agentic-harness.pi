## PR Reply Extension

Mode for responding to GitHub PR review feedback. The LLM
drives the workflow by calling `pr_reply` with different
actions, iterating through threads, analyzing feedback,
and posting replies.

### Architecture

**Pattern**: Multi-step tool + mode (like TDD's `tdd_phase`).
The LLM calls the tool repeatedly, advancing through the
review workflow one step at a time.

**Key insight**: The extension doesn't call the LLM — the LLM
calls the extension. Each tool call returns rich context
(thread data, code, conversation) for the LLM to reason about.
The LLM presents analysis to the user, then calls back with
the chosen action.

### Workflow

```
activate → next → (implement|reply|skip|defer) → next → ... → deactivate
```

Each `next` returns the full thread conversation, code context,
and metadata. The LLM reads this, analyzes the feedback, and
recommends an action to the user.

### Files

- `state.ts` — Domain types, thread lifecycle, defaults
- `lifecycle.ts` — Mode activation, status line, widget, persist/restore
- `transitions.ts` — Context injection for LLM awareness
- `analysis.ts` — Build analysis prompt for the LLM
- `implementation.ts` — Commit tracking, TDD coordination
- `replies.ts` — Reply composition guidance for the LLM
- `api/github.ts` — GraphQL fetch, REST reply posting
- `api/parse.ts` — PR link parsing
- `api/repo.ts` — Repository discovery, dependent PR detection
- `ui/format.ts` — File summary formatting for panels
- `ui/panels.ts` — Summary panel
- `index.ts` — Tool registration, action handlers, event wiring

### Tool Actions

| Action | Purpose |
|--------|---------|
| `activate` | Load PR, show summary, enter mode |
| `next` | Present next pending thread with context |
| `implement` | Mark thread for implementation |
| `reply` | Post a reply (no code changes) |
| `done` | Mark implementation complete, post reply |
| `skip` | Skip thread |
| `defer` | Defer thread for later |
| `deactivate` | Exit mode, report results |

### Coordinates With

- **TDD mode** — Listens for `tdd_phase` done/stop events.
  Automatically collects commits and links them to threads.
- **Plan mode** — Shares plan directory for context-aware analysis.
- **Commit guardian** — Uses `ctx.ui.editor` for reply editing.

### Design Notes

**Why multi-step instead of a loop?**
The extension can't call the LLM — it runs inside a tool call.
Each step returns context, the LLM reasons about it, and calls
back. This lets the LLM provide genuine analysis rather than
canned recommendations.

**Why session-only state?**
Reviews take minutes to hours. In-memory state is simpler and
follows the TDD mode pattern.

**Thread ordering?**
By file path, then line position, then timestamp. Matches how
developers read diffs.
