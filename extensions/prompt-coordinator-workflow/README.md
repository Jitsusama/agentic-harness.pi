# prompt-coordinator-workflow

Owns the single `before_agent_start` hook that appends the
resident system-prompt block, assembled from contributors in a
fixed order and frozen once per session.

## Why it exists

Several extensions want to add always-on text to the system
prompt: the authoring conventions, recalled memory, captured
correction rules. If each appended on its own
`before_agent_start`, the order would depend on load order and
the bytes could churn turn to turn. This coordinator gives the
resident block one deterministic assembly point and freezes it
per session, so the prompt is stable and the ordering is
explicit.

## What it does

- Extensions register a `PromptContributor` (id, order,
  `contribute(ctx)`) through `lib/prompt`.
- On `before_agent_start`, the coordinator assembles the
  contributors in ascending order, joins their non-empty text,
  and appends the result to the system prompt.
- The block is frozen on first assembly, so every turn in a
  session gets byte-identical output even if a contributor's
  text later changes. A new session gets a fresh freeze.
- The freeze is written to the session log as a
  `prompt-coordinator-frozen` entry and read back on every session
  start, so a `/reload` or a resumed session renders the same bytes.

## Why the freeze outlives a reload

A freeze kept only in memory was assembled again by every reload
and resume. Recalled memory takes in every fact retained during the
session and captured rules every rule filed, so the system prompt
came back different and the next turn rewrote the whole context at
the cache-write price: about $2.40 at 300k tokens under one-hour
retention. Measured live on pi 0.87.1, one retained fact then a
reload: the turn after fell back to the end of the tool definitions
(43,342 tokens read, 18,892 written) before this, and read all
62,862 after. What was learned since the freeze is already in the
conversation, so keeping the old bytes loses nothing.

## Contributors

- `convention-context` at order 0: the authoring conventions,
  inside a git work tree.
- `memory` (recalled quest-scoped facts) and captured
  correction rules register at higher orders as they land.

## Design

The composition and freeze live in `lib/prompt` as pure,
tested logic; this extension is the thin wiring that creates a
per-session frozen prompt and appends it.
