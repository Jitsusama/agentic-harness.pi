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

The `pr_workflow` tool is a conversation-first surface for
reviewing pull requests. The user talks; the agent calls
the tool action by action; the panels and findings grow
around the conversation rather than steering it from a
menu.

This skill teaches you (the agent) which action to call
when, what state each action expects, and how to keep the
user oriented through a multi-round pipeline.

## The pipeline at a glance

```
load → council → judge → [critique?] → findings/decide × N → post
           ↙                                                    ↗
        (sweep stack PRs, then)  stack-critic  →  findings/decide  →  post
```

Each step is a separate tool action. The user stays in
prose; you translate intent into calls.

| Action | When to call |
|---|---|
| `load` | First action of any PR session. User said "review PR 42" or pasted a URL. |
| `status` | User asks "where are we?", "what's loaded?", or "how much has this cost?". Read-only; surfaces the per-stage and total token/cost spend, including stack-critic state. |
| `council-config` | User wants to set or change the reviewer roster. |
| `council` | Round 1: fan out the roster. User said "run the review", "kick it off". |
| `judge-config` | User wants to set or change the judge model. |
| `judge` | Round 2: consolidate the council output. Run after `council`. |
| `critique` | Round 3 (optional): roster pushes back on the judge. Only after the gate. |
| `stack-critic-config` | User wants to set the cross-PR stack critic reviewer (only once per session). |
| `stack-critic` | Run cross-PR synthesis across the discovered stack. Requires judge findings on at least one PR. |
| `findings` | Show the current findings view (judge + critique + decisions, plus stack-level findings if any). Read-only. |
| `decide` | Round 4: record the user's verdict on one finding. Pass `scope="stack"` for stack-critic findings. |
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

## When to call what

### Starting a session

User: "let's look at PR 42 in my-org/my-repo"

```
pr_workflow action=load pr="my-org/my-repo#42"
```

If they're already in a checkout and give a bare number,
that works too: `pr="42"`.

After `load`, the tool returns metadata + diff summary +
stack info if any. Surface a short prose summary; don't
dump JSON.

### Configuring the council

Default: ask the user once whether they have a roster
they want to use. If they say "use whatever", pick a
reasonable default and tell them what you picked:

```
pr_workflow action=council-config reviewers=[
  { id: "fast",    model: "anthropic:claude-sonnet-4.5", tools: ["read","grep","glob","ls"] },
  { id: "skeptic", model: "openai:gpt-5",                 tools: ["read","grep","glob","ls"] }
]
pr_workflow action=judge-config judge={ id: "judge", model: "anthropic:claude-opus-4" }
```

The roster and judge persist across `/reload`. If a
session already has them set, don't re-prompt — just
mention them in your status update.

### Running the rounds

```
pr_workflow action=council   # round 1
pr_workflow action=judge     # round 2
```

After `judge`, ALWAYS present the consolidated findings
to the user in prose and ask the gate question:

> Judge consolidated N findings: M critical, P medium, Q minor.
> Self-rated {confidence} on the list.
>
> Want a critique pass (round 3 — the roster pushes back),
> or jump straight to deciding what to post?

The judge's self-signal informs your framing but doesn't
decide for the user. If they want critique:

```
pr_workflow action=critique  # round 3
```

Otherwise skip to round 4.

### When a reviewer crashes

If the council or critique summary surfaces a retry
hint ("reviewer X returned no findings with warnings"),
offer the user the targeted retry rather than re-running
the whole round:

```
pr_workflow action=council-retry reviewerId=skeptic
pr_workflow action=critique-retry reviewerId=skeptic
```

Council retry allocates new finding ids past the current
max, so decisions the user already made on un-retried
findings stay stable. Critique retry replaces the
reviewer's positions on the judge's findings; nothing
else moves. Do not call retry against a reviewer who
legitimately came back empty (no warnings); that's a
silent reviewer, not a crashed one.

The judge has no retry primitive — re-running
`action=judge` is itself idempotent (it overwrites
`lastJudge`).

### Round 4: user synthesis

Round 4 is conversation, not a panel. Loop through
findings with the user. Useful patterns:

- "Show me the findings" → `action=findings`
- "Endorse #10" → `action=decide findingId=10 verdict=endorse`
- "Dismiss #11, it's a false positive" →
  `action=decide findingId=11 verdict=dismiss reason="false positive"`
- "Soften #12 — keep it but non-blocking" →
  `action=decide findingId=12 verdict=qualify note="non-blocking, worth a follow-up"`
- "Edit #13: change the subject to '…'" →
  `action=decide findingId=13 verdict=edit subject="…"`
- "Promote everything I endorsed" — make the calls
  yourself one at a time; the API takes single
  findingIds.

You're allowed to suggest verdicts. The decision is the
user's; your job is to keep momentum. If they're
silent on a finding, ask.

### Posting

```
pr_workflow action=post                    # default event=COMMENT
pr_workflow action=post event=APPROVE      # if approving
pr_workflow action=post event=REQUEST_CHANGES body="Holding this one until X"
```

The tool refuses empty reviews. If `findings` shows
nothing endorsed/qualified/edited/promoted, push back
on the user before calling `post`.

Findings verdict'd as `fix` are intentionally excluded
from the posted review. They mean "I'll handle this
myself, don't post a comment." Mix `endorse`/`fix`
freely on the same council run: posted comments and
self-applied fixes are independent.

### Applying fixes

Council, judge and critique do the *research* in a
worktree (so the user's working tree stays clean), but
the *edits* happen in the user's actual checkout, where
you already are. The flow has two halves: deciding
(`verdict="fix"`) and applying (`fix-next` → main-loop
edits → `fix-done`).

**Deciding.** First, mark the findings the user wants
to address as fixes rather than comments:

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
  → {findingId: 14, finding: {...}, instructions: "..."}
  or null if the queue is empty
```

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

Loop back to `fix-next` for the next finding. When it
returns a null context, the queue is done. The user is
free to interrupt at any prose turn between `fix-next`
and `fix-done` — the loop is in the agent, not the
tool, so course-correction is free.

If the user changes their mind on a queued finding
("actually that's not worth fixing"), use `fix-skip`
with a short reason:

```
pr_workflow action=fix-skip findingId=15 skipReason="not worth a follow-up"
```

The findings view renders the three terminal states
inline: `queued for fix — <instructions>`,
`✓ fixed in <sha>`, or `fix skipped — <reason>`.

Things the loop does NOT do:

- **Apply edits itself.** Edits live in your main loop
  so the user can interrupt. The tool only supplies the
  next finding's context and records outcomes.
- **Run checks automatically.** The agent reads the
  repo and decides what to run (lint, tests). The tool
  doesn't carry a checks-config in v1.
- **Push.** Pushing is the user's call after the queue
  is done. `git push` works as normal.
- **Cross-PR.** Stack-level fixes (`verdict=fix` on
  stack findings) are out of scope for v1. Use
  per-PR fixes only.

Neither half involves the worktree the council ran in.
That worktree exists for read-only research; nothing in
the normal flow writes back to it.

### Navigating a stack

When `load` reveals the PR is part of a stack, the
user can navigate parent / child PRs:

```
pr_workflow action=stack          # show the chain
pr_workflow action=stack-next     # "what's downstream?"
pr_workflow action=stack-prev     # "what's upstream?"
```

The `stack-next` and `stack-prev` actions do NOT
re-load the new PR themselves. They return the
adjacent PR's ref and tell you to call `load`. This
is intentional: every significant state change goes
through prose, so the user has a chance to intervene
("hold on, before moving on, let's post the current
findings first").

If the cursor has fan-out children (multiple
downstream PRs), `stack-next` returns no automatic
pick and the action's prose includes the child count.
Ask the user which fork to follow.

Reviews don't currently follow the chain
automatically; each PR is a separate council /
judge / critique session. That's intentional — each
stage focuses on one diff at a time.

State across cursor moves: when the user moves off a
PR that has any council, judge, critique or decision
state, those slots snapshot under `state.stackRuns[N]`
automatically. When the cursor returns to N, the
snapshot rehydrates. This means the user can sweep
the stack without losing work.

### Stack-aware review

When the user wants to surface cross-PR observations
(inconsistent error handling between layers,
duplicated logic across the stack, API choices that
only make sense if a downstream PR lands), reach for
`stack-critic`.

Workflow:

1. Sweep the stack at least once: load each PR, run
   council + judge, optionally critique. Each PR's
   findings stash in `state.stackRuns` when the user
   moves the cursor.
2. Configure the stack-critic reviewer (once per
   session):

   ```
   pr_workflow action=stack-critic-config stackCritic={
     id: "stack-critic",
     model: "anthropic:claude-opus-4"
   }
   ```

3. Run it from any PR in the stack:

   ```
   pr_workflow action=stack-critic
   ```

   The critic sees each PR's title and consolidated
   judge findings (live for the cursor PR;
   snapshotted for off-cursor PRs).

4. Stack findings appear in `findings` under a
   'Stack-level findings (decide with scope=stack)'
   section, with S-prefixed ids:

   ```
   [S1] [issue] Inconsistent retry semantics (home: #42; spans: 42, 43)
      PR 42 retries 5xx; PR 43 retries any failure.
      decision: pending
   ```

5. Decide on them with `scope="stack"`:

   ```
   pr_workflow action=decide findingId=1 verdict=endorse scope=stack
   ```

6. Post. Each stack finding lands on its `homePrNumber`.
   Findings home to the cursor PR post in the same
   call as per-PR findings. Findings home to other PRs
   in the stack get skipped — navigate to the home PR
   and re-run `post` to flush them.

When NOT to run `stack-critic`:

- The session has only one PR loaded (no stack). The
  tool will refuse with 'No stack discovered'.
- No PR in the stack has been judged yet. The tool
  will refuse with 'No judge findings on any PR'. Run
  judge on at least one PR first.
- The user is in 'just this PR' mode and doesn't want
  cross-PR feedback. Stack-critic findings can wait.

## Existing threads

The pipeline above describes one direction: pi posts
findings to GitHub. The reverse direction — reading
what reviewers already left and responding — happens
through three small actions.

When to reach for them:

- User: "what review comments are still open on this
  PR?" → `action="threads"`. Render the result.
- User: "reply to the second one saying I'll fix it in
  a follow-up" → `action="reply" threadIndex=2
  replyBody="I'll fix in a follow-up PR."`
- User: "resolve the first thread" →
  `action="resolve" threadIndex=1`.

The display index is 1-based and matches the `[T#]`
label the tool renders. The snapshot is whatever the
last `action="threads"` returned, so if you suspect
upstream activity (the user just got a slack ping),
re-run `threads` to refresh the index before replying.

Reply and resolve don't auto-update the snapshot. They
post the mutation and return success; the next
`threads` call will reflect the new state. If the user
is about to do several replies, render `threads` once,
call the mutations, then optionally re-run `threads`
to confirm.

### Confirmation gates

Both `reply` and `resolve` pause for an in-terminal
confirmation panel before hitting GitHub. The panel
renders the thread's existing comments alongside the
proposed reply (or the resolution intent), so the user
sees what they're approving before any mutation
lands.

Key behaviour the user might rely on:

- **Enter** approves and fires the mutation.
- **`r`** rejects; the action returns a clean error and
  nothing posts.
- **Escape** cancels (same outcome as `r`).
- **Shift+Escape** (reply only) opens an inline note
  editor. Whatever the user types replaces the proposed
  reply body. Useful when the user wants to tweak
  wording without round-tripping back through prose.

The agent's responsibility doesn't change: still draft
the reply text in prose first, confirm in conversation,
*then* call the tool. The gate is the second line of
defense, not the first. If the user rejects or edits in
the panel, surface that outcome back in prose so the
conversation reflects what actually happened.

The gate short-circuits to approved when running
headless (no TUI). In that case the prose-level
confirmation is the only gate, which matches how the
agent operates in batch / CI contexts where there's no
person to interact with a panel.

What NOT to use these for:

- Posting initial review comments — that's
  `action="post"` and the rest of the pipeline.
- Drafting wholesale rewrites of a thread — reply
  appends; GitHub doesn't support editing someone
  else's prior comments.
- Walking the full reply history in detail — the tool
  shows the first comment plus a 'more reply' count.
  For deep history, point the user at the URL in the
  rendered output.

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

Don't ask the user to memorise these. Translate their
intent: "drop it" → dismiss, "keep but tone it down" →
qualify with note, "change the wording" → edit with
subject/discussion.

## Posted comment format

The tool renders comments in Conventional Comments
format:

```
**issue:** Subject line

Discussion body.

> Qualifier: (only on qualify verdict)

_Raised by: fast, skeptic._
```

Inline comments (line-located findings) post against
the file/line. File- and scope-level findings collect
in the review body summary.

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

Every finding traces back to which reviewers raised it
(`agreement.raisedBy`). Don't strip that. Users can tell
"two models agreed" from "one model speculated"; the
distinction matters for calibration.

## When NOT to call the tool

- The user asks about a PR conceptually ("what's the
  best way to land a stacked PR?") — answer in prose;
  don't load anything.
- The user is replying to review feedback on their own
  PR — that's `pr_reply`, not `pr_workflow`.
- The user wants to write a self-review on their own
  PR — that's `pr_annotate`.

## Companion skills

- `code-review-standard` — what to look for in code.
- `comment-format` — Conventional Comments rules; the
  tool already renders this format, but use it for your
  prose framing too.
- `prose-standard` — Canadian English, no em-dashes, no
  excessive politeness in posted comments.
- `github-cli-convention` — for any `gh` commands you
  run outside the tool (clone, fetch, etc).
- `github-pr-review-guide` — broader review methodology
  not specific to this tool.
