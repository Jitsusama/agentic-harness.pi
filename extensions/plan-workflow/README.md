# Plan Workflow Extension

Collaborative planning as a persistent, staged workflow, anchored
on a living document. Not a one-shot gate.

The [planning-guide skill](../../skills/planning-guide/) teaches
the methodology and the document format. This extension keeps the
stage state, paints the scoreboard, enforces the one read-only
guardrail, and routes the plan document to a durable home. It is
a tracker, not a turnstile: it never prompts the user.

## The Stages

A plan moves through three working stages and two terminal ones,
driven by the `plan` tool. Returning to `think` is how a plan is
reopened when discovery invalidates it.

| Action | From → To | Posture |
|---|---|---|
| `think` | idle/plan/build → think | Read-only: dig and debate |
| `draft` | think → plan | Read-only except the plan document |
| `build` | plan → build | Writes allowed |
| `conclude` | active → concluded | Terminal: the document is the record |
| `retire` | active → retired | Terminal, with a reason |

Questions are plain conversation; there is no interview tool.

## The Document Is the Source of Truth

The plan is a real markdown file with a small YAML front-matter
floor (`id`, `stage`, `updated`, `sessions`) and standard
checkboxes for progress. Only those two things are parsed;
everything else is the author's prose.

Because the document holds the state, a plan survives a
`/reload`, a `/resume`, and a cold start in a brand-new session.
On restore the document on disk wins over any cached pointer, so
the state can never drift. `/plan list` shows the plans in your
plan home (newest first, with stage and progress) so you can
find one to resume, and `/plan-attach <path|id>` re-adopts it
from a fresh session. The `sessions` list is maintained
automatically.

The listing walks down from the plan home, so per-project
subfolders are covered, and it stays cheap over a large tree: it
skips dot and vendor directories, probes only each file's head,
and reads a document in full only once it looks like a plan.

## The Only Guardrail

While a plan is in its read-only stages (`think`, `plan`), the
agent may not implement: code writes and git-mutating commands
are blocked, with the single exception of writing the plan
document. This block is agent-facing, never a user prompt, and it
is the whole of what "do not build while we are still thinking"
means. Once the plan moves to `build`, everything is allowed.

## Routing

The document is written to a durable location anchored to the
**main** worktree root, so a plan started inside a linked
worktree is never reaped with it. A downstream extension can
register a router through the [plan-routing library](../../lib/plan-routing/)
to send plans into a custom home; the durable default is just the
fallback.

## Status Display

While a plan is active, the status line shows a constant `Plan`
label beside a glyph that carries the stage through its shape and
colour (`○` think, `◐` plan, `●` build, `✓` concluded, `⊘`
retired). A widget alongside it shows the stage, the checkbox
progress and the plan's title. Both fall silent at idle.
