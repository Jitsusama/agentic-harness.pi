# pr-workflow

Conversation-first pull request review and reply, built on
pi's TUI primitives and the neovim-pi companion protocol.

## What This Replaces

This extension supersedes the three earlier PR extensions:

- `pr-review-workflow` — multi-step review of someone else's PR
- `pr-reply-workflow` — addressing review feedback on your own PR
- `pr-annotate-workflow` — inline self-review comments on a PR

The earlier extensions split a single workflow (the PR
lifecycle) across three task-scoped state machines, each with
its own panels, gates and rituals. The redesign collapses
them into a single conversation: the user prompts in prose,
the agent calls `pr_workflow`, and the extension grows panels,
narration and findings around the conversation rather than
steering it from a menu.

## Design Principles

- **Conversation is the surface.** No top-level menus. Tools
  exist for the agent to call; panels exist for the agent to
  show specific artifacts (findings list, diff view, council
  status). The user always drives by prompt.
- **Multi-model review council.** Findings are produced by
  parallel calls to several models, then reduced through a
  judge round, surfaced to the user, and posted on approval.
  Council mechanics live in `extensions/pr-workflow/council/`
  once that capability scaffolds.
- **Neovim is the code viewer.** When paired with a neovim
  via the `neovim-pi` extension, the agent can call
  `nvim_buffer_open` with `pi://pr/.../file/<sha>/<path>`
  URIs to view PR files in nvim. Unpaired sessions fall
  back to inline diff rendering for context only;
  substantive viewing needs nvim.
- **Stack-aware.** When the active PR is part of a stack, the
  council reasons across the whole stack, and post gates lay
  out the order of operations explicitly.
- **Self-applied fixes.** Findings the user wants to handle
  themselves get verdicted `fix` and stay out of the posted
  review. The main agent (or the user) does the edit in
  the real checkout when ready; the worktree is
  research-only.
- **No global keymaps or autocmds.** Nothing in nvim is
  hijacked by default. Pi steers nvim via the documented
  companion protocol; the user always wins.

## Actions

One `pr_workflow` tool, 24 actions. The user drives the
flow conversationally; the agent translates intent into
the right action.

**Setup**

- `action="load"` — parse a PR reference, fetch metadata
  + diff, detect stack, surface a one-screen summary.
  Diff and stack fetches are best-effort.
- `action="status"` — read-only state report (debug-y;
  IDs, configs, raw counts).
- `action="summary"` — one-shot user-facing view of
  the loaded PR: header, stack position, threads,
  council state, fix queue. Read-only; reads cached
  snapshots only and never fetches. Use for "what's
  the state of this PR?" between scenarios.
- `action="council-config"` — set the reviewer roster
  (id + model + tools).
- `action="judge-config"` — set the judge model.
- `action="stack-critic-config"` — set the stack-critic
  reviewer (separate model for cross-PR pattern
  detection).

**Round 1 — fan-out**

- `action="council"` — dispatch the roster against a
  shared worktree; each reviewer returns findings,
  warnings and usage.
- `action="council-retry" reviewerId=<id>` — re-run one
  reviewer in the most recent council run and substitute
  their output in place. Finding ids are allocated past
  the current max so decisions on un-retried findings
  stay stable.

**Round 2 — synthesis**

- `action="judge"` — consolidate round-1 findings with
  `agreement.raisedBy` attribution and a judge
  self-signal.

**Round 3 — optional pushback**

- `action="critique"` — the round-1 roster takes per-
  finding positions (`agree | disagree | qualify |
  amplify`) on the judge's list.
- `action="critique-retry" reviewerId=<id>` — re-run one
  reviewer in the most recent critique run. Critique
  entries reference judge findings by `findingId`, so
  substitution is direct.

**Stack critic (cross-PR)**

- `action="stack-critic"` — once at least one PR in the
  stack has been judged, run the stack-critic reviewer
  to surface cross-PR findings (inconsistent error
  handling, abstractions that shift between layers,
  duplicated logic). Reads live + snapshotted judge
  findings from across the stack. Each emitted finding
  carries a `homePrNumber` (post destination) and
  `spans` (every PR the finding refers to).

**Round 4 — user**

- `action="findings"` — render judge + critique + user
  decisions as one consolidated view. Stack-critic
  findings appear in their own section with S-prefixed
  ids (`[S1]`, `[S2]`…) so the user knows to pass
  `scope="stack"` on decide.
- `action="decide" findingId=<n> verdict=<v>
  scope=<"pr" | "stack">` — record the user's verdict
  (`endorse | qualify | edit | dismiss | promote |
  fix`). The two id spaces are independent: a finding
  with id 3 in each scope gets two separate decisions.

**Posting**

- `action="post"` — send eligible findings to GitHub as
  a PR review (inline comments for line-located
  findings, body summary for file- and scope-level
  findings). Stack findings whose `homePrNumber` matches
  the cursor PR post alongside the per-PR review;
  stack findings home to other PRs in the stack skip
  with a clear reason (the user posts them by
  navigating to the home PR and re-running post).

**Stack navigation**

- `action="stack"` — render the discovered PR stack with
  cursor.
- `action="stack-next"` — re-load the next PR
  downstream.
- `action="stack-prev"` — re-load the PR upstream.

**Existing review threads**

The round-trip on posting: read what reviewers (or a
previous pi-workflow run) have already left, respond to
specific threads, mark them resolved.

- `action="threads"` — fetch the loaded PR's review
  threads (open, resolved, outdated) and store an
  indexed snapshot on the session. Renders
  `[T1]`, `[T2]`… with location (`path:line` or
  `(PR-level)`), flags, and an excerpt of the first
  comment.
- `action="reply" threadIndex=N replyBody="..."` — post
  a reply to the thread at index N (1-based, from the
  most recent `threads` snapshot). Pauses for an
  in-terminal confirmation gate that renders the
  thread's existing comments alongside the proposed
  reply. Shift+Esc opens the note editor to edit the
  reply inline; `r` rejects; Enter approves.
- `action="resolve" threadIndex=N` — mark the thread
  at index N resolved. Idempotent: resolving an
  already-resolved thread is a no-op. Pauses for an
  in-terminal confirmation gate that renders the
  thread context with an explicit "Mark thread
  resolved" intent line. `r` rejects; Enter approves.

Both gates short-circuit to approved when running
headless (`ctx.hasUI === false`). When there's no panel
to render, the user is trusted to have approved
out-of-band.

Index stability: the snapshot is whatever
`threads` last fetched. If the upstream conversation
changes, re-run `threads` to refresh the index before
replying or resolving.

**Fix queue**

Findings decided with `verdict="fix"` get queued for the
user (or the main agent on their behalf) to apply as
commits in the working checkout instead of posting them
as review comments. The queue itself is just the `fix`-
verdicted decisions in the order the judge emitted them;
these actions walk it and record outcomes.

- `action="fix-next"` — return the next pending fix
  with its subject, location, instructions, and queue
  counts. Returns a `null` context plus a "queue done"
  / "no fixes queued" summary when the queue is empty.
  Pure read; doesn't mutate state.
- `action="fix-done" findingId=<n> commitSha=<sha>` —
  record that a commit landed for finding `n`. The
  decision is mutated in place to attach
  `resolvedBy: { commitSha, recordedAt }`; subsequent
  `fix-next` calls skip it.
- `action="fix-skip" findingId=<n> skipReason="..."`
  — abandon a queued fix. Records `skipped: { reason,
  recordedAt }`; the findings view shows
  `fix skipped — <reason>`.

The loop is non-autonomous on purpose: `fix-next`
hands the agent the next finding's context, the agent
does the actual edit / checks / commit in its main
loop using normal pi tooling (where the user can
interrupt at any prose turn), and `fix-done` records
the outcome. The tools never apply edits themselves.

The findings view renders fix-verdicted decisions in
three states: `queued for fix — <instructions>`,
`✓ fixed in <sha>`, or `fix skipped — <reason>`. The
`status` action's `fix queue:` line gives the
breakdown at a glance.

State across cursor moves: per-PR council run, judge
run, critique run and decisions snapshot under
`state.stackRuns[N]` when the user moves off PR N (if
it has any review state), and rehydrate when N
returns. Stack-critic state
(`state.stackCritic`, `state.stackDecisions`) is
session-global, not per-PR — one cross-PR run covers
the whole stack.

The council and critique summaries surface a retry hint
at the top when a reviewer returned empty with warnings
(the classic 'reviewer crashed' shape), so the user sees
the suggested follow-up action before scrolling through
the rest of the output.

## Sibling Extensions

- [`pr-workflow-verify`](../pr-workflow-verify/) registers
  a `verify_output` tool that reviewer subagents call to
  self-validate their JSON against the same TypeBox
  schemas the parent will parse against. The parent
  resolves this extension's absolute path (via
  `verify-path.ts`) and injects it into every reviewer
  subagent through `pi --extension <path>`. Schemas live
  in [`schemas.ts`](./schemas.ts) and are the single
  source of truth for both sides.

## Files

- `state.ts` — runtime state for the session (active PR,
  findings, council, companion linkage). Grows as
  capabilities land.
- `load.ts` — parses a PR reference and engages the
  session. Pure; no network calls.
- `fetch.ts` — fetches PR metadata via `gh api graphql`.
  Splits the wire boundary: `parsePrMetadata` is a pure
  parser; `fetchPrMetadata` is a thin orchestrator.
- `stack.ts` — walks a PR's base/head chain to discover
  the stack it belongs to. The walker depends on a
  `PrSearch` interface so it stays pure and testable.
- `search.ts` — GitHub-backed `PrSearch` factory. Runs one
  GraphQL query per neighbour lookup; the walker calls it
  at most `maxDepth * 2` times per discovery.
- `buffer.ts` — `pi://pr/...` URI scheme: parser, builder,
  resolver and filetype inference. All pure; the file
  fetcher is injected.

## `pi://pr` URI Scheme

The extension defines one URI shape today:

```
pi://pr/<owner>/<repo>/<number>/file/<sha>/<path>
```

The SHA is baked into the URI so the resolver is
self-contained and doesn't depend on workflow state.
Re-loading the PR generates fresh URIs against the new
head; existing URIs continue to resolve at the SHA they
name.

On startup the extension emits a
`neovim-pi:register-handler` event asking neovim-pi to
route `buffer.uri.resolve` calls through its handler.
It also subscribes to `neovim-pi:ready` and re-emits on
receipt so the handshake works regardless of which side
loaded first. The cross-package contract is documented
in neovim.pi's `doc/protocol.md`.

When neovim-pi is absent (not installed, or doesn't
speak this contract), both emits are no-ops and
`pi://pr/...` URIs won't open in nvim. The agent can
still construct URIs for use once a paired session is
available.
- `index.ts` — extension registration. Reads as a table of
  contents.

Subsequent capabilities live in their own subdirectories
(e.g. `council/`, `findings/`, `companion/`, `post/`) and are
wired into `index.ts` via named imports.

## Tests

`tests/extensions/pr-workflow/` covers the state factory.
Each new capability ships its own tests at the same depth.
