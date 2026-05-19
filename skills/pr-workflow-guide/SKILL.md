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
```

Each step is a separate tool action. The user stays in
prose; you translate intent into calls.

| Action | When to call |
|---|---|
| `load` | First action of any PR session. User said "review PR 42" or pasted a URL. |
| `status` | User asks "where are we?", "what's loaded?". Read-only. |
| `council-config` | User wants to set or change the reviewer roster. |
| `council` | Round 1: fan out the roster. User said "run the review", "kick it off". |
| `judge-config` | User wants to set or change the judge model. |
| `judge` | Round 2: consolidate the council output. Run after `council`. |
| `critique` | Round 3 (optional): roster pushes back on the judge. Only after the gate. |
| `findings` | Show the current findings view (judge + critique + decisions). Read-only. |
| `decide` | Round 4: record the user's verdict on one finding. |
| `post` | Ship the review to GitHub. Final action. |

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
from the posted review (a fix supplants the comment).
Mix `endorse`/`fix` freely on the same council run:
posted comments and applied fixes are independent.

### Applying fixes

When the user wants the agent to MAKE the change rather
than COMMENT on it:

```
pr_workflow action=decide findingId=14 verdict=fix
pr_workflow action=decide findingId=15 verdict=fix instructions="match existing helper-fn style"
pr_workflow action=fix
```

What `fix` does:

- Drains every finding verdict'd as `fix` since the
  last council run.
- Dispatches one coding subagent per finding into the
  council's worktree.
- Subagent reads, edits and writes files using its own
  pi tools.
- Returns a summary: which findings landed, which
  failed, what files were touched.

What `fix` does NOT do:

- It doesn't commit. The user reviews the diff in nvim
  (or the worktree) and commits when satisfied via
  normal git tooling.
- It doesn't push. Pushing to someone else's branch is
  an out-of-band action and intentionally manual.
- It doesn't run tests automatically. Configurable
  checks layer on in a follow-up.

Optional `fix-config` before `fix` if the user wants a
different model for fixing than for reviewing:

```
pr_workflow action=fix-config model="anthropic:claude-opus-4"
```

The fix model persists across `/reload`.

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
