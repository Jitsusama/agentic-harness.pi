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

## Contributors

- `convention-context` at order 0: the authoring conventions,
  inside a git work tree.
- `memory` (recalled quest-scoped facts) and captured
  correction rules register at higher orders as they land.

## Design

The composition and freeze live in `lib/prompt` as pure,
tested logic; this extension is the thin wiring that creates a
per-session frozen prompt and appends it.
