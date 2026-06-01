# Convention Context Extension

Injects a compact, resident reminder of the authoring
conventions into the system prompt at the start of every turn.
The reminder names the rules the guardians and gates enforce so
the AI gets a PR, issue, commit, review comment or Slack message
right the first time, and the gates have less to block.

## Why It Exists

A skill loads its body into context only when read, and
compaction later evicts it. The conventions then drift out of
the model's working memory mid-session, which is exactly when it
reoffends. This block rides `before_agent_start`, so it is
resident and compaction-immune: it is reapplied every turn and
survives the eviction the gates exist to backstop.

The gates still enforce regardless of context. This block is the
always-on baseline that reduces how often they have to fire, not
the enforcement itself.

## What It Does

On every turn, when the working directory is inside a git work
tree, it appends a short block to the system prompt that names:

- the prose rules (Canadian spelling, no emdashes, no curly
  quotes or Unicode ellipsis, no decoration in prose);
- the closed PR and issue section sets, built from the same
  constants the section gate enforces so they cannot drift;
- the commit shape and the Slack formatting rules.

The block is scoped to a git work tree because that is where PR,
commit, issue and Slack authoring happens. An unrelated working
directory does not pay the token cost.

## Design

- `rules.ts` builds the block. The PR and issue section lines
  come from `PR_SECTIONS` / `ISSUE_SECTIONS`, so the reminder,
  the gate and the skills all trace to one source.
- `scope.ts` decides whether a directory is inside a git work
  tree via `git rev-parse --is-inside-work-tree`, failing closed
  so the block is omitted rather than injected on a guess.
- `index.ts` wires the two to `before_agent_start`.
