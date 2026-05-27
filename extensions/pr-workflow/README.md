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
  Council mechanics live in `council.ts` + `council-action.ts`
  with the judge, critique and review stages each in
  their own pair of files.
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

## User Journeys

These aren't modes the user picks. They're trajectories
that emerge from prose: the agent reads the user's intent
and adapts. The same session can move between trajectories
without ceremony.

### 1. Self-review before pushing

> "review what i have locally"

The user wants a second set of eyes on uncommitted work
before opening a PR. The agent loads the local diff,
runs the council in the background while the user reads
in nvim, then enters the fix loop: each endorsed finding
turns into an edit + commit through `commit-guardian`.
Nothing gets posted; the terminal is a cleaner working
tree.

**Typical actions:** `load` (local) → `council` → `judge`
→ `decide verdict=fix` for each → `fix-next` /
`fix-done` loop.

### 2. Deep review of someone else's PR

> "review pr 1234"

The user wants to read the whole change themselves and
use the council as a sanity check. The agent loads the
PR, opens the diff in nvim, fires the council in
parallel. When the council finishes, the user triages
findings (`endorse` what they agree with, `dismiss`
false positives, `qualify` soft-disagreements, `edit`
where wording can be sharpened) and posts the review.

**Typical actions:** `load` → `council` → `judge` →
(optionally `critique`) → `findings` → `decide` × N →
`post`.

### 3. Addressing review feedback on your own PR

> "let me see #1234"

The user is the PR author and has inbound comments to
respond to. The agent fetches threads, walks them with
the user, and either drafts a reply (`reply`) or pairs
a fix-commit with a reply pointing at the commit sha.
The two action families (`threads/reply/resolve` for
inbound, `council/findings/decide/post/fix-*` for
self-review) stay separate; see the "Two inboxes"
section in `pr-workflow-guide`.

**Typical actions:** `load` → `threads` → per thread,
either `reply` + `resolve`, or main-loop edit →
`commit-guardian` → `reply` referencing the sha →
`resolve`.

### 4. Delegated review with council

> "i don't have time to read all of this; what does the council say?"

The user wants the council to do the reading and surface
a shortlist. The agent runs the council without
requiring the user to walk the diff first; findings
include more inline context so the user can decide each
one without leaving the conversation. Reviewing the
posted output still passes through Round 4: the user is
the final decision-maker even when they didn't read the
code.

**Typical actions:** `load` → `council` → `judge` →
`findings` → `decide` × N (with the user leaning on
the agent's prose framing) → `post`.

### 5. Pair-debugging unfamiliar code

> "someone pinged me on this PR; i don't know this area"

The user wants help orienting before forming an opinion.
The agent reads the diff and surrounding code, narrates
structure (file roster, the "heart" of the change,
behavioural deltas) and finds the riskiest section. No
council; no findings-as-a-list. The output might be one
or two well-aimed comments posted manually, or just a
reply to whoever pinged them.

**Typical actions:** `load` → free-form reading +
narration → maybe `threads` to see what's already been
said → prose conversation, no formal pipeline.

### Cross-trajectory invariants

Five things stay true across every journey:

- Prose is the entry point. There's no mode picker.
- Council is never required. Trajectories 1, 2 and 4
  use it; 3 and 5 typically don't.
- Round 4 is non-negotiable when a council ran. The
  user is always the final reviewer.
- Surface shifts (pi ↔ nvim) happen mid-prose, not via
  ceremony commands.
- Inbound threads and self-review findings stay in
  separate action families even when the user is
  weaving between them in conversation.

The agent's defaults shift per trajectory (whether to
auto-suggest council, how much inline context to show
in findings, what to recommend at Round 4's close).
`pr-workflow-guide` covers the inference rules.

## Actions

One `pr_workflow` tool, 25 actions. The user drives the
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
  (id + model + tools). Omit `reviewers` to load the
  roster from a config file.
- `action="judge-config"` — set the judge model. Omit
  `judge` to load the judge from a config file.
- `action="review"` — run the stack-wide review
  pipeline: stack-aware council fan-out followed by
  stack-aware judge.

### Worktree provider API

Reviewer subagents receive a working tree path, not the
user's checkout. By default, pr-workflow provisions that
path with native `git worktree add --detach <sha>`. Private
or workspace-specific packages can replace that behaviour
without importing this extension by registering a provider
over Pi's event bus.

A provider implements the structural `WorktreeProvider`
contract: `id`, optional `priority`, optional `canHandle`,
`ensure(request)` and `release(handle)`. `ensure` receives
`owner`, `repo`, `sha` and optional `branch`; it retrieves
whatever refs it needs, creates the working tree and returns
an absolute path in the handle. Higher-priority providers
run before the native git fallback.

Fix worktrees have their own provider role because the
lifecycle is different: reviewers need detached, SHA-keyed
research trees, while fixes need a persistent branch checkout
where commits and pushes work normally. A `FixWorktreeProvider`
implements `id`, optional `priority`, optional `canHandle`,
`provision(request)`, `list()` and `cleanup(request)`.

Review guidance is separate from both worktree provider roles.
Private or workspace-specific packages can also register a
`ReviewContextProvider` with `id`, optional `priority`,
optional `canHandle` and `context(request)`. Matching review
context providers contribute prompt addenda for council,
judge, stack review and critique prompts while pr-workflow
keeps the generic review standard.

Event names:

- `pr-workflow:ready:v1` — emitted once the registration API
  is ready. Payload has `registerWorktreeProvider(provider)`,
  `listWorktreeProviders()`,
  `registerFixWorktreeProvider(provider)`,
  `listFixWorktreeProviders()`,
  `registerReviewContextProvider(provider)` and
  `listReviewContextProviders()`.
- `pr-workflow:worktree-provider:register:v1` — emit a
  review worktree provider directly. Use this as the
  load-order fallback when the private extension may load
  after pr-workflow.
- `pr-workflow:fix-worktree-provider:register:v1` — emit a
  branch-checkout fix worktree provider directly.
- `pr-workflow:review-context-provider:register:v1` — emit a
  review-context provider directly.

Private extensions should listen for `ready` and emit direct
`register` events during activation. That makes registration
safe regardless of extension load order.

### Configuration defaults

The extension ships with no built-in reviewer or judge
defaults. Users can define them in JSON at the first
available path:

1. `$PR_WORKFLOW_CONFIG`
2. `$XDG_CONFIG_HOME/pi/pr-workflow.json`
3. `~/.config/pi/pr-workflow.json`

Example:

```json
{
  "reviewers": [
    {
      "id": "fast",
      "model": "anthropic/claude-sonnet-4-5",
      "thinkingLevel": "low",
      "tools": ["read", "grep", "glob", "ls"]
    }
  ],
  "judge": {
    "id": "judge",
    "model": "anthropic/claude-opus-4-7",
    "thinkingLevel": "high"
  }
}
```

Reviewer ids must be unique, and the judge id must be
distinct from every council reviewer id.

### State directory

Reviewer artifacts, supervised stream logs, fix-worktree
admin state and other persistent files live under:

```
${XDG_STATE_HOME:-~/.local/state}/pi/agentic-harness.pi/pr-workflow/
```

The `agentic-harness.pi/` segment scopes state to this pi
package so it doesn't collide with other pi extension
packages installed in the same user account. Sibling
extensions in this package each get their own peer
directory.

Earlier versions of this extension stored state at
`${XDG_STATE_HOME:-~/.local/state}/pi/pr-workflow/` (no
package segment). That path is abandoned; any leftover
artifacts under the old location are inert and safe to
delete.

**Review standard**

Every reviewer-like subprocess gets a built-in review
standard before its role-specific instructions. The standard
applies across application code, infrastructure as code,
configuration, migrations and technical docs. It defines a
finding as material when it identifies concrete risk to
behaviour, correctness, security, privacy, data integrity,
compatibility, operability, cost, test confidence,
maintainability, reader understanding or relied-on local
conventions. Subprocesses are also told to load relevant Pi
skills so project and user conventions specialize that base
standard.

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

**Live Progress Panel**

Long-running reviewer actions (`council`, `review`,
`judge` and `critique`) replace the prompt editor with a
focused progress panel while the tool is still running. This
matters because normal prompts queue behind the active tool
call; the prompt-area panel is the interrupt surface that
remains reachable mid-run.

- Use ↑/↓ to select a reviewer.
- Press `r` to cancel the selected reviewer. The run keeps
  any completed reviewer output and records that reviewer
  as cancelled.
- Press Esc to cancel the whole active run. Reviewers that
  start after the request, such as a stack judge after
  fan-out, inherit the cancellation immediately.

**Stack-wide review**

- `action="review"` — run one stack-aware council
  fan-out across every PR in the stack, then one
  stack-aware judge. Per-PR findings are stored on the
  cursor/snapshot path; cross-PR findings carry a
  `homePrNumber` (post destination) and `spans` (every
  PR the finding refers to). A later `action="critique"`
  critiques both the per-PR findings and the cross-PR
  findings from this stack run.

**Round 4 — user**

- `action="findings"` — render judge + critique + user
  decisions as one consolidated view. Cross-PR
  findings appear in their own section with S-prefixed
  ids (`[S1]`, `[S2]`…) so the user knows to pass
  `scope="stack"` on decide.
- `action="add-finding" label=<label> subject="..."
  discussion="..." [file="..." start=<line> end=<line>
  side=<old|new|both>]` — add a user-authored finding
  to the current per-PR review list. This is for synthesis
  moments where the user notices a material comment that
  the council missed. The finding remains pending until
  the user records a normal `decide` verdict.
- `action="decide" findingId=<n> verdict=<v>
  scope=<"pr" | "stack">` — record the user's verdict
  (`endorse | qualify | edit | dismiss | promote |
  fix`). The two id spaces are independent: a finding
  with id 3 in each scope gets two separate decisions.
  `verdict="edit"` accepts any combination of
  `subject`, `discussion` and `label` (at least one
  required); unspecified fields fall through to the
  original finding.

**Posting**

- `action="post"` — send eligible findings to GitHub as
  a PR review. Line findings use inline comments only
  when the loaded diff has a valid anchor; unanchorable
  line findings, file findings, scope findings and stack
  findings fall back to a sparse review body. Stack
  findings whose `homePrNumber` matches the cursor PR
  post alongside the per-PR review;
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
returns. Cross-PR finding state
(`state.stackFindingRun`, `state.stackDecisions`) is
session-global, not per-PR — one cross-PR run covers
the whole stack.

The council and critique summaries surface a retry hint
at the top when a reviewer returned empty with warnings
(the classic 'reviewer crashed' shape), so the user sees
the suggested follow-up action before scrolling through
the rest of the output.

## Verify Packs

Each reviewer stage gets its own one-file verify extension
plus a companion skill. The extension registers a
`verify_output` tool that the subagent calls to validate
its JSON against the stage's schema; the skill teaches the
output contract and the verify protocol.

The pack entry points live under
[`lib/internal/pr-workflow-verify/packs/`](../../lib/internal/pr-workflow-verify/packs/),
not under `extensions/`. Pi auto-discovers `.ts` files
directly under `extensions/`, and all five packs register
the same `verify_output` tool with different stage
schemas; auto-loading them would collide on tool name or
make the active verifier depend on load order. The
resolver injects the right pack into a reviewer subagent
via `--extension`; nothing else loads them.

- [`packs/council.ts`](../../lib/internal/pr-workflow-verify/packs/council.ts)
  with skill
  [`pr-workflow-council-output`](../../skills/pr-workflow-council-output/SKILL.md).
- [`packs/judge.ts`](../../lib/internal/pr-workflow-verify/packs/judge.ts)
  with skill
  [`pr-workflow-judge-output`](../../skills/pr-workflow-judge-output/SKILL.md).
- [`packs/critique.ts`](../../lib/internal/pr-workflow-verify/packs/critique.ts)
  with skill
  [`pr-workflow-critique-output`](../../skills/pr-workflow-critique-output/SKILL.md).
- [`packs/stack-review.ts`](../../lib/internal/pr-workflow-verify/packs/stack-review.ts)
  with skill
  [`pr-workflow-stack-review-output`](../../skills/pr-workflow-stack-review-output/SKILL.md).
- [`packs/stack-judge.ts`](../../lib/internal/pr-workflow-verify/packs/stack-judge.ts)
  with skill
  [`pr-workflow-stack-judge-output`](../../skills/pr-workflow-stack-judge-output/SKILL.md).

The parent resolves the per-stage pack via
[`verify-packs.ts`](./verify-packs.ts) and injects it into
each reviewer subagent through `pi --extension <path>`
plus `pi --skill <path>`. Schemas live in
[`schemas.ts`](./schemas.ts) and are the single source of
truth; the per-stage packs and the parent parser both read
from there. Shared validation plumbing lives alongside the
packs in
[`lib/internal/pr-workflow-verify/`](../../lib/internal/pr-workflow-verify/).

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

Each capability is a pair of files: a pure data layer
(`council.ts`, `judge.ts`, `critique.ts`, `review.ts`,
`fix.ts`, `threads.ts`, `summary.ts`) and an action layer
that wires it to the tool surface (`council-action.ts`,
`judge-action.ts`, etc.). `index.ts` reads as a table of
contents.

## Tests

`tests/extensions/pr-workflow/` mirrors the source layout.
Each capability ships its own test file at the same depth;
pure-render modules are tested independently of orchestration
so vitest doesn't have to resolve `pi-tui`.
