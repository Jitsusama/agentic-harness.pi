---
name: pr-workflow-guide
description: >
  How to drive the `pr_workflow` tool: a conversation-first
  PR review system with multi-model council pipeline (fan-
  out reviewers, judge consolidation, optional critique,
  user synthesis) and posting to GitHub. Use when the user
  asks to "review PR N", "run a council review", "look at
  this PR", "post a review", or any request to read or
  comment on a pull request. Pairs with code-review-standard
  for evaluation criteria, comment-format for comment shape,
  and prose-standard for written voice.
---

# PR Workflow Guide

Drive the `pr_workflow` tool. The user speaks in prose;
translate intent into `action=` calls. Panels and findings
grow around the conversation, never the reverse.

This skill covers: which action to call when, what state
each expects, how trajectories shift defaults, and the
back-half flows (fix loop, thread replies, stack
navigation).

## The pipeline at a glance

```
load → review → [critique?] → findings/decide × N → post
  ↳ just this PR: council → judge → [critique?] → findings/decide × N → post
```

Each step is a separate tool action. The user stays in
prose; you translate intent into calls.

| Action | When to call |
|---|---|
| `load` | First action of any PR session. User said "review PR 42" or pasted a URL. |
| `status` | Debug-y session dump: IDs, configs, raw counts, per-stage cost. Use when the user asks a low-level state question or you need to verify wiring. |
| `reset` | Clear the active PR, runs, decisions, threads and status line when the conversation has moved on to unrelated work. Keeps reviewer roster and judge config. Use before switching away from PR review or before loading an unrelated PR if stale status would mislead the user. |
| `summary` | User-facing "what's the state of this PR?" panel. Header + stack + threads + council + fix queue, composed from cached snapshots. Use when the user asks open questions like "where are we on this?" or comes back to a session after a break. Never fetches — if threads aren't cached the panel prompts to run `action=threads`. |
| `council-config` | User wants to set or change the reviewer roster. Omit `reviewers` to load configured defaults. |
| `council` | Round 1: fan out the roster. User said "run the review", "kick it off". |
| `judge-config` | User wants to set or change the judge model. Omit `judge` to load configured defaults. |
| `judge` | Round 2: consolidate the council output. Run after `council`. |
| `review` | Stack-wide context review: one stack-aware council fan-out plus one stack-aware judge. Use for "review the whole stack" or "do all of them". |
| `critique` | Round 3 (optional): roster pushes back on the judge. Works after either `judge` or stack-wide `review`. |
| `findings` | Show the current findings view (judge + critique + decisions, plus stack-level findings if any). Read-only. |
| `add-finding` | Round 4: add a user-authored per-PR finding when synthesis surfaces a material comment the council missed. Follow with `decide` before posting. |
| `decide` | Round 4: record the user's verdict on one finding. Pass `scope="stack"` for cross-PR findings from `review`. |
| `post` | Ship eligible findings to GitHub as a PR review. Stack findings home to the cursor PR post alongside per-PR findings. |
| `stack` | Render the discovered PR stack with cursor highlighted. |
| `stack-next` | Identify the PR downstream of the cursor and return its ref. |
| `stack-prev` | Identify the PR upstream of the cursor and return its ref. |
| `threads` | Fetch the loaded PR's existing review threads. Renders them indexed as `[T1]`, `[T2]`… |
| `reply` | Reply to a thread by its `[T#]` index. Requires `threadIndex` and `replyBody`. |
| `resolve` | Mark a thread resolved by its `[T#]` index. Requires `threadIndex`. |
| `fix-next` | Return the next finding queued for fix (verdict=fix) with no recorded outcome. Pure read. |
| `fix-done` | Record that a commit landed for a queued fix. Requires `findingId` and `commitSha`. |
| `fix-skip` | Abandon a queued fix with a reason. Requires `findingId` and `skipReason`. |
| `fix-worktree-list` | Enumerate fix worktrees that have accumulated under the pr-workflow state dir. Read-only; no arguments. |
| `fix-worktree-cleanup` | Remove the fix worktree for a PR. Requires `pr`; pass `force:true` to delete uncommitted edits. |

## Reading the user's trajectory

Classify the session from the first prompt before
chaining actions. The user never names the shape; infer
it. Five common shapes:

| User's prose | Shape | Call next |
|---|---|---|
| "review pr N" / a URL | Deep review of someone else's PR | `load`, then ask the user whether they want a council. Don't auto-fire one. |
| "let me see #N" (their own PR) | Addressing review feedback | `load`, then `threads`. Stop the menu instinct here — they want their existing thread inbox. |
| "what does the council say about N" | Delegated review | `load`, then immediately `council`. The user explicitly asked for the multi-model take. |
| "review what i have locally" | Self-review before pushing | `load` (local), then `council`, then run the fix loop with `fix-next`. |
| "someone pinged me; i don't know this code" | Pair-debug | `load`, then read and narrate. No formal pipeline. |

These aren't hints. Pick a trajectory in your head before
choosing the next action. `action=load` itself returns a
`suggestedNext` array (rationale included); use it as a
structural assist, not a substitute for the trajectory
you inferred from the user's prose.

### What changes per trajectory

Bias your defaults based on the inferred shape:

- **Auto-suggest council?** Yes for delegated and
  self-review; ask first for deep review (some users
  want to read uncoloured); no for pair-debug.
- **How much inline context in `findings`?** Lean
  toward terse for deep review (the user already read
  the code) and verbose for delegated (the user is
  trusting your eyes).
- **What to suggest at Round 4 close?** Post for
  trajectories 2 and 4; fix for trajectory 1; ask for
  trajectory 3 (mix is normal); skip Round 4 entirely
  for trajectory 5 (no formal pipeline ran).
- **Where do mutations happen?** Self-review: edits in
  the user's checkout. All others: edits go via
  `fix-next`/main-loop/`fix-done` only when the user
  asks for them; never auto.

Re-classify on shift cues without ceremony. Narrate the
shift in one line ("OK, switching to fix-and-commit")
and proceed.

| Cue | Shift |
|---|---|
| "actually let me read this myself" | delegated → deep review; stop pushing council, open files in nvim |
| "just fix the obvious stuff" | review → self-apply; queue blockers for fix instead of post |
| "let's just ship what we have" | self-apply → post; promote remaining findings to comments |

## When to call what

### Resetting or switching context

PR workflow status is sticky by design while a PR review is in progress, but
it must not pretend the user is still working on an old PR after the
conversation moves on. When the user says they're done, asks how to turn the PR
workflow off, or switches to unrelated work, call:

```
pr_workflow action=reset
```

`reset` clears the loaded PR, council/judge/critique runs, decisions, thread
snapshots, stack state, fix queue source data and status-line indicator. It
keeps the reviewer roster and judge config so the next review can reuse the
same setup. After reset, do not call `summary`, `findings`, `threads`, `post` or
fix actions until a new `load` happens.

When moving directly from one unrelated PR to another, prefer `reset` first if
there is any chance stale findings, fix queue counts or thread indexes would
confuse the user, then call `load` for the new PR.

### Starting a session

User: "let's look at PR 42 in my-org/my-repo"

```
pr_workflow action=load pr="my-org/my-repo#42"
```

Bare numbers work inside a checkout: `pr="42"`.

`load` returns metadata + diff summary + stack info.
Surface a short prose summary; don't dump JSON at the
user.

### Configuring the council

Ask once whether the user has a roster preference. If
they defer ("use whatever"), use configured defaults if
they exist:

```
pr_workflow action=council-config
pr_workflow action=judge-config
```

If no config file exists, ask for a roster instead of
inventing built-in defaults. An explicit roster still
works:

```
pr_workflow action=council-config reviewers=[
  { id: "fast",    model: "anthropic/claude-sonnet-4-5", thinkingLevel: "low",    tools: ["read","grep","glob","ls"] },
  { id: "skeptic", model: "openai/gpt-5",                thinkingLevel: "medium", tools: ["read","grep","glob","ls"] }
]
pr_workflow action=judge-config judge={ id: "judge", model: "anthropic/claude-opus-4-7", thinkingLevel: "high" }
```

Model format rules (pi's `--model` flag):

- Bare model id (`claude-opus-4-7`) — pi infers the provider.
- `provider/model` with a **slash** (`anthropic/claude-opus-4-7`).
- Never `provider:model` with a **colon** — pi reads `:` as a `model:thinkingLevel` separator and rejects the call.

`thinkingLevel` is optional and accepts `off` / `low` /
`medium` / `high`. Omit it to let pi fall back to its
session default. Same field shape on reviewer and
`judge` config.

The `tools` palette is an allowlist; reviewers can only
call what you name. You do NOT need to list
`verify_output` — the dispatcher always appends it so
the subagent can self-validate its JSON before ending.
Stick to the investigation tools the reviewer actually
needs (`read`, `grep`, `glob`, `ls`, optionally `bash`).
Omitting `tools` entirely makes pi fall back to all
loaded tools, which also keeps `verify_output`
accessible.

Configured defaults come from the first available path:

1. `$PR_WORKFLOW_CONFIG`
2. `$XDG_CONFIG_HOME/pi/pr-workflow.json`
3. `~/.config/pi/pr-workflow.json`

Use this JSON shape:

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

There are no built-in reviewer defaults. Reviewer ids
must be unique, and the judge id must be distinct from
every council reviewer id within the session.

Roster and judge persist across `/reload`. If a session
already has them, mention them in your status update;
don't re-prompt.

### Worktree providers

Reviewer subagents run inside a working tree provisioned
by pr-workflow. The public extension defaults to native
`git worktree add --detach <sha>`. Private extensions can
register provider implementations over Pi's event bus for
workspace-specific checkout systems.

Event names:

- `pr-workflow:ready:v1`
- `pr-workflow:worktree-provider:register:v1`
- `pr-workflow:fix-worktree-provider:register:v1`

A review worktree provider receives `{ owner, repo, sha,
branch? }`, retrieves the ref however it needs, creates a
working tree and returns a handle with an absolute `path`.

Fix worktrees have a separate provider role because they need a
persistent branch checkout for commits and pushes. A fix
worktree provider receives `{ owner, repo, number, branch }`,
returns a branch-checked-out `path`, and owns list/cleanup for
its worktrees.

Review guidance is a separate provider role. Private
extensions may register review-context providers through
`pr-workflow:review-context-provider:register:v1` or the
`ready` payload. A review-context provider receives
`{ owner, repo, prNumber, sha, branch?, stage }` and returns
prompt guidance for council, judge, stack review or critique.
Do not encode private workspace rules in this public skill;
private packages own their worktree providers, review-context
provider and any proprietary behaviour.

### Running the rounds

```
pr_workflow action=council   # round 1
pr_workflow action=judge     # round 2
```

After `judge`, ALWAYS present findings in prose and ask
the gate question:

> Judge consolidated N findings: M critical, P medium, Q minor.
> Self-rated {confidence} on the list.
>
> Want a critique pass (round 3 — the roster pushes back),
> or jump straight to deciding what to post?

The judge's self-signal informs your framing; it doesn't
decide for the user. If they want critique:

```
pr_workflow action=critique  # round 3
```

Otherwise skip to round 4.

### When a reviewer crashes

When the council or critique summary surfaces a retry
hint ("reviewer X returned no findings with warnings"),
read the warnings BEFORE proposing a retry. The result
includes the `Pi stderr:` line whenever a reviewer's
subprocess exited non-zero — that's pi's actual error
message, and it tells you whether a retry will fix it.

Common patterns:

| Stderr says | Cause | Fix |
|---|---|---|
| `Error: Model "..." not found` | Wrong model id or colon-form `provider:model` | Re-run `council-config` with the corrected `model` (slash or bare). |
| `Error: Provider "X" not found` | Slash form with an unknown provider | Use `pi --list-models` to find the right provider/model pair. |
| `Error: Invalid thinking level` | Bad `thinkingLevel` value | Re-run config with `off` / `low` / `medium` / `high`. |
| `API error: ... 401 ...` | Missing or expired key for that provider | Hand off to the user; pi can't fix auth from inside the tool. |
| (no `Pi stderr:` line) | Reviewer produced output but no JSON block | Genuine candidate for `council-retry`. |

Retry mechanics:

```
pr_workflow action=council-retry reviewerId=skeptic
pr_workflow action=critique-retry reviewerId=skeptic
```

Cancellation mechanics happen in the live prompt-area
progress panel, not through another tool call. A prompt
typed while `council`, `review`, `judge` or `critique` is
still running queues behind that active tool, so it can't
interrupt the stuck reviewer.

When the progress panel replaces the prompt editor:

- Use ↑/↓ to select a reviewer.
- Press `r` to cancel the selected reviewer.
- Press Esc to cancel the active run.

Cancelling one reviewer keeps other reviewer output.
Cancelling the run aborts every active reviewer and also
cancels later subprocesses in the same action, such as the
stack judge that would normally start after fan-out.

- Council retry allocates new finding ids past the
  current max. Existing decisions stay stable.
- Critique retry replaces the reviewer's positions on
  the judge's findings; nothing else moves.
- Don't retry a reviewer who came back empty without
  warnings — that's a silent reviewer, not a crash.
- Don't retry when the stderr line names a config
  problem (model not found, bad thinking level). Fix
  the config first, then re-run `council` from scratch.
- Judge has no retry. `action=judge` is idempotent
  (overwrites `lastJudge`).

### Round 4: user synthesis

Round 4 is conversation, not a panel. Walk findings
with the user. Translate intent to `decide` calls:

| User says | Call |
|---|---|
| "show me the findings" | `action=findings` (compact one-row-per-finding index; pass `verbose:true` for the full discussion + critique text) |
| "endorse #10" | `action=decide findingId=10 verdict=endorse` |
| "dismiss #11, false positive" | `action=decide findingId=11 verdict=dismiss reason="false positive"` |
| "soften #12 — non-blocking" | `action=decide findingId=12 verdict=qualify note="non-blocking, worth a follow-up"` |
| "edit #13: subject is '…'" | `action=decide findingId=13 verdict=edit subject="…"` |
| "edit #13: anchor at serve.go:200-210" | `action=decide findingId=13 verdict=edit file="serve.go" start=200 end=210` (location overrides accept `file`, `start`, `end`, `side`; partial overrides inherit the rest from the original) |
| "add this as a new inline comment" | `action=add-finding label=suggestion decorations=["blocking"] subject="..." discussion="..." file="path" start=47`, then `decide` the new id |
| "promote everything I endorsed" | call `decide` per finding; API takes single ids |

Suggest verdicts when the user is silent on a finding.
Keep momentum; ask if you need direction. Final
decision is theirs.

### Posting

```
pr_workflow action=post                    # default event=COMMENT
pr_workflow action=post event=APPROVE      # if approving
pr_workflow action=post event=REQUEST_CHANGES body="Holding this one until X"
```

The tool refuses empty reviews. If `findings` shows
nothing endorsed/qualified/edited/promoted, push back
before calling `post`.

`fix`-verdicted findings are excluded from the posted
review by design ("I'll handle this myself"). Mix
`endorse` and `fix` freely on the same council run;
posted comments and self-applied fixes are
independent.

The generated top-level review body is intentionally
sparse. Line findings post inline only when the loaded
diff exposes a valid anchor; file-level, scope-level,
stack-level and unanchorable line findings fall back to
the body below a short explanation.

### Applying fixes

Council / judge / critique research in a detached,
SHA-keyed worktree. Edits happen in a separate fix
worktree dedicated to the PR (PR-number-keyed, with
the branch checked out) so commits land cleanly and
the user's primary checkout stays untouched.

Two halves: decide (`verdict="fix"`), then apply
(`fix-next` → main-loop edits in the fix worktree →
`fix-done`).

**Deciding.** Mark findings as fixes instead of
comments:

```
pr_workflow action=decide findingId=14 verdict=fix
pr_workflow action=decide findingId=15 verdict=fix instructions="match existing helper-fn style"
```

The optional `instructions` field is a free-form note
on how the fix should land. It rides along on the
decision and shows up in `fix-next`.

**Applying.** When the user says "apply the queue" or
"now do the rename", walk it:

```
pr_workflow action=fix-next
  → {findingId: 14, finding: {...}, worktree: {path, branch}, instructions: "..."}
  or null if the queue is empty
```

**Use the fix worktree.** `fix-next`'s prose summary
includes a `Worktree: <path>  (branch <ref>)` line.
Before reading, editing, running tests or committing,
`cd` into that path. The branch is already checked
out there. The user's primary checkout must not be
touched by the fix loop.

If `fix-next` reports `Worktree provisioning failed:
...`, surface that error to the user and stop — do
not silently fall back to the primary checkout.
Resolve the underlying issue (often the branch is
already checked out somewhere, or `origin/<branch>`
doesn't exist) and re-run `fix-next`.

Apply the edit using your normal tools (`read`, `edit`,
`write`, `bash`). The finding's `location` tells you
the file and line; `discussion` tells you what's wrong;
`instructions` (if present) tell you how the user wants
it fixed. Run whatever checks make sense (lint, tests).
Commit through `commit-guardian` like any other commit
— the guardian fires automatically and the user
approves the message.

Once the commit lands, record it:

```
pr_workflow action=fix-done findingId=14 commitSha=a1b2c3d
```

Loop back to `fix-next` for the next finding. Null
context means the queue is done. The user can
interrupt at any prose turn between `fix-next` and
`fix-done`; the loop is in the agent, not the tool.

If the user changes their mind on a queued finding
("actually that's not worth fixing"), use `fix-skip`
with a short reason:

```
pr_workflow action=fix-skip findingId=15 skipReason="not worth a follow-up"
```

The findings view renders the three terminal states
inline: `queued for fix — <instructions>`,
`✓ fixed in <sha>`, or `fix skipped — <reason>`.

The loop does NOT:

- **Apply edits itself.** Edits live in your main loop
  so the user can interrupt.
- **Run checks automatically.** You read the repo and
  decide what to run (lint, tests).
- **Push.** Pushing is the user's call after the
  queue empties.
- **Cross-PR fix.** Stack findings can't take
  `verdict=fix` in v1. Per-PR only.

The council's research worktree is read-only; nothing
in the normal flow writes back to it.

### Navigating a stack

When `load` reveals a stack, the user can move between
parent / child PRs:

```
pr_workflow action=stack          # show the chain
pr_workflow action=stack-next     # "what's downstream?"
pr_workflow action=stack-prev     # "what's upstream?"
```

Stack navigation rules:

- `stack-next` / `stack-prev` return the adjacent
  PR's ref; they don't re-load. Call `load` after.
  This is intentional: every state change goes
  through prose so the user can intervene.
- Fan-out children: `stack-next` returns no
  automatic pick and includes the child count. Ask
  the user which fork to follow.
- Reviews don't auto-follow the chain. Each PR is
  its own council / judge / critique session.
- State snapshots into `state.stackRuns[N]` when the
  cursor moves off PR N and rehydrates on return.
  The user can sweep the stack without losing work.

### Stack-aware review

Reach for `review` when the user wants cross-PR
observations: inconsistent error handling between
layers, duplicated logic across the stack, API
choices that only make sense if a downstream PR
lands.

Workflow:

1. Load any PR in the stack.
2. Configure the council roster and judge if they are
   not already set.
3. Run:

   ```
   pr_workflow action=review
   ```

   The stack-aware reviewers see every PR as a
   separate section, preserving PR boundaries, and
   return `perPr` plus `crossPr` findings. The judge
   consolidates the same shape.

4. Ask whether the user wants critique. If they do, run:

   ```
   pr_workflow action=critique
   ```

   The critique target includes per-PR findings and
   cross-PR findings from the stack review.

5. Per-PR findings appear in `findings` for the
   cursor PR. Stack findings appear in a
   'Stack-level findings (decide with scope=stack)'
   section, with S-prefixed ids.

6. Decide on cross-PR findings with `scope="stack"`:

   ```
   pr_workflow action=decide findingId=1 verdict=endorse scope=stack
   ```

7. Post. Each stack finding lands on its `homePrNumber`.
   Findings home to the cursor PR post in the same
   call as per-PR findings. Findings home to other PRs
   in the stack get skipped. Navigate to the home PR
   and re-run `post` to flush them.


## Existing threads

Threads are inbound feedback (humans or other AIs).
Three actions handle them: `threads`, `reply`,
`resolve`.

### Two inboxes, kept separate

Threads and council findings are two different streams
of work. Don't merge them.

| Threads | Council findings |
|---|---|
| Human (or other AI) reviewers wrote them on GitHub | Pi generated them by reading the diff |
| Social obligation — someone is waiting for a reply | Technical discovery — the user decides what's worth doing |
| Close with `reply` + `resolve` | Close with `decide` + `post` or `fix` |
| Action family: `threads`, `reply`, `resolve` | Action family: `council`, `judge`, `critique`, `findings`, `decide`, `post`, `fix-*` |

Urgency differs: "alice is waiting for a reply on T1"
has a deadline; "the council noticed F3 might be a
race" is optional. Merging them hides which is which.

Rules:

- Open question ("what's on this PR?") — run both,
  present in two sections, not a merged list.
- Thread-mode prose ("address what alice said") —
  don't auto-run the council.
- Council-mode prose ("check this for me") — don't
  reach for thread tools unless asked.

The two streams can cross in conversation (the user
might dismiss F5 because alice already raised it in
T1, citing T1 in the dismissal reason). They should
not cross in the tool surface: no `ingest-threads`
action, no `findings.source = thread` field.

### When to reach for thread actions

| User says | Call |
|---|---|
| "what review comments are still open?" | `action="threads"` |
| "reply to the second one saying I'll fix in a follow-up" | `action="reply" threadIndex=2 replyBody="I'll fix in a follow-up PR."` |
| "resolve the first thread" | `action="resolve" threadIndex=1` |

Index rules:

- 1-based; matches the `[T#]` label the tool renders.
- Snapshot is whatever `threads` last fetched. Re-run
  `threads` to refresh before replying when you
  suspect upstream activity (a slack ping, etc).
- `reply` and `resolve` don't auto-refresh the
  snapshot. They post the mutation; the next
  `threads` call reflects the new state. For batched
  replies, render `threads` once, call mutations,
  then optionally re-run `threads` to confirm.

### Confirmation gates

`reply` and `resolve` both pause for an in-terminal
confirmation panel before hitting GitHub. The panel
renders the thread's existing comments alongside the
proposed reply (or resolution intent).

Gate controls:

- **Enter** approves; mutation fires.
- **`r`** rejects; action returns a clean error,
  nothing posts.
- **Escape** cancels (same outcome as `r`).
- **Shift+Escape** (reply only) opens an inline
  editor; the typed body replaces the proposed reply.

Protocol stays the same regardless of the gate: draft
in prose, confirm in conversation, *then* call the
tool. The gate is a second line of defense, not the
first. If the user rejects or edits in the panel,
surface that outcome back in prose.

Headless contexts (no TUI) short-circuit the gate to
approved. The prose confirmation is the only gate in
batch / CI runs.

Don't use these for:

- Posting initial review comments — that's
  `action="post"`.
- Wholesale thread rewrites — reply appends; GitHub
  doesn't support editing prior comments.
- Walking deep reply history — the tool shows the
  first comment plus a 'more reply' count. Point the
  user at the URL for the rest.

## Verdict reference

Six verdicts. Each carries the fields needed to render
the finding correctly.

| Verdict | Required extra | What it does |
|---|---|---|
| `endorse` | — | Finding stands as written. Posts. |
| `qualify` | `note` | Keep but soften / mark non-blocking. Note appears as `> Qualifier: ...` in the posted comment. |
| `edit` | `subject` and/or `discussion` | Replace the finding's text before posting. At least one field. |
| `dismiss` | `reason` (optional but expected) | Drop. Does not post. |
| `promote` | — | Explicit "include in posted review". Mostly redundant with endorse; use when the user wants to mark something as posting-bound without endorsing the prose. |
| `fix` | `instructions` (optional) | "I'll handle this myself; don't post a comment." Bookmarks the finding for self-application. The main agent (or the user) does the edit in their real checkout when ready. |

Translate intent; don't enumerate verdicts at the user:

- "drop it" → dismiss
- "keep but tone it down" → qualify with note
- "change the wording" → edit with subject/discussion
- "i'll fix it" → fix with optional instructions

## Posted comment format

The tool renders comments in Conventional Comments
format, with the label first so the header remains
parseable:

```
issue (blocking): ⚠️ Subject line

Discussion body.

> Qualifier: (only on qualify verdict)

_Raised by: fast, skeptic._
```

Inline comments post against valid file/line anchors in
the loaded diff. File-level, scope-level, stack-level and
unanchorable line findings collect in the review body
using the same header format.

## Tracking cost

`status` shows token + cost usage per stage and as a
running total. The breakdown looks like:

```
usage:
  council: 12,400 tokens, $0.1830
  judge:    3,100 tokens, $0.0520
  critique: 8,600 tokens, $0.1240
  total:   24,100 tokens, $0.3590
```

Each stage reports the spend from its most recent run.
The figures come from pi's own `usage` events in the
subagent JSON stream. When a stage hasn't run, its line
is omitted. When no stage has run, the whole `usage:`
block is omitted.

Only the three research stages have subagents and so
only they show up here. Round-4 decisions and any
follow-up edits happen in the main agent's loop and
feed pi's normal session-level cost reporting.

## Honest provenance

Don't strip `agreement.raisedBy` when narrating
findings. Users distinguish "two models agreed" from
"one model speculated"; the distinction calibrates
trust.

## When NOT to call the tool

- Conceptual PR questions ("what's the best way to
  land a stacked PR?") — answer in prose; don't load.
- PR description / commit message rewrites — that's
  editor work. Use `edit` / `write` directly.
- CI failure or build-status questions —
  `gh pr checks N` beats spinning up the workflow.

## Companion skills

- `code-review-standard` — what to look for in code.
- `comment-format` — Conventional Comments rules; the
  tool already renders this format, but use it for your
  prose framing too.
- `prose-standard` — Canadian English, no em-dashes, no
  excessive politeness in posted comments.
- `github-cli-convention` — for any `gh` commands you
  run outside the tool (clone, fetch, etc).
- `code-investigation-guide` — how to read a codebase
  when the user wants to pair-debug an unfamiliar PR
  before deciding what to say about it.
