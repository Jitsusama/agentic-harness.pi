---
name: review-guide
description: >
  How to read and review a change through the `review`,
  `review_see`, `review_say` and `review_draft` tools,
  whatever system hosts it: GitHub, Meteorite, a GitLab
  merge request, or a range of commits nobody has proposed
  at all. Covers attaching the change you are working on,
  reading a diff and a conversation, judging a stack by its
  provenance, composing a review as a draft, planning what
  publishing will do, and reporting degradation honestly.
  Use when asked to "review
  this change", "read this PR", "what did people say about
  it", "reply to that thread", "resolve those comments",
  "approve it", "review these commits", or any request to
  look at or comment on a change. Pairs with
  code-review-standard for what to evaluate, comment-format
  for how a remark reads, and prose-standard for voice.
---

# Review Guide

Four tools cover reviewing. They speak one vocabulary
regardless of what hosts the change, so the same phrasing
works on a GitHub pull request, a Meteorite change and a
stack of local branches.

They are split by what you are trying to do, not by what you
are doing it to. The subject is nearly always the change, so
splitting by subject would only ask you to guess which tool
owned which question.

| Tool | For |
|---|---|
| `review` | What you are working on: attach, detach, next, prev, capabilities |
| `review_see` | Everything reading tells you: change, diff, checks, stack, changes, threads, reviews, messages, findings |
| `review_say` | Saying something now: reply, comment, resolve, unresolve, react |
| `review_draft` | Composing a whole review, then planning and publishing it |

## Attach the Change, Then Stop Naming It

`review attach` binds the change you are working on, and
every later call can leave it out. This is the difference
between reading a change and reciting its number six times,
and the recitation is where the typos live.

```
review attach change:2000970
review_see diff
review_see threads
review_say reply thread:3 body:"..."
```

The rule when a call names nothing is always the same: one
attached change is used and said out loud, several are
listed rather than guessed between, and a change you name
explicitly is never second-guessed. Acting on the wrong
change is worse than being asked which one.

`review next` and `review prev` move the attachment along
the stack, which is how to walk a stack without naming each
member. A node that forks reports both children instead of
choosing, for the same reason.

Note that stepping the attachment moves nothing on disk. It
changes which change the tools talk about, not which branch
is checked out anywhere.

## A Finding Is Not Yet a Remark

A finding is something a review pass raised. Nobody has seen it
but you. A remark is something you have decided to say. Keeping
those apart is the whole point of the findings surface:

```
review_see findings              what was raised, numbered [F#]
review_draft decide finding:3 settle:"promote"
review_draft decide finding:4 settle:"dismiss"
review_draft plan                what publishing would do
```

Promoting copies the finding into the draft as a remark, taking
its own words unless you supply better ones. Dismissing drops it
and says so. Nothing reaches the change until the draft is
published, so a finding you never decide is a finding nobody
ever reads.

Finding numbers climb and are never reused, even after the list
is cleared, because people refer to findings by number out loud
and a recycled number makes an earlier conversation wrong.

## Never Assume GitHub

The provider is resolved from configuration, then from
provider claims, then from the shapes the user has mapped.
A reference is a URL, an `owner/repo#number` short form, or
a bare number inside a checkout.

This matters most when it is invisible. A checkout can carry
remotes pointing at two different systems, one of them a
read-only mirror, and a review posted to the mirror succeeds
and is read by nobody. Say which provider answered when it
is relevant, and never report a generic failure when you can
name the provider that was asked.

Ask `review capabilities` when you need to know what a
provider can do before offering it. It leads with which
provider is holding the change, because "who handles this"
and "what can be done to it" are the same question asked
twice. A facet that is absent is absent on purpose: it means
the provider cannot do that thing, not that it forgot to say
so.

## A Change Nobody Has Proposed Is Still a Change

Pass `base` and `head` for a range, or `refs` for a stack of
branches. Nothing needs to host it. This is how to review
work before it is proposed, or work that will never be
proposed at all.

Where nothing hosts the target, `review_draft render` writes
the review as a document rather than failing. Reach for that
instead of reporting that publishing is impossible.

## Read Provenance Before Trusting a Stack

Every stack says where its shape came from.

- `authoritative` means the server recorded the parentage.
  Act on it.
- `derived` means it was inferred from base and head names,
  and it is wrong at the edges: a merged parent or a renamed
  branch ends the chain early.

Pass that caveat on when it changes the answer. A derived
stack presented as fact is the failure this field exists to
prevent.

## Compose, Then Plan, Then Publish

Build a review up in a draft rather than posting remark by
remark. A draft persists, so a review can span a session and
be picked back up by id.

1. `review_draft open` on the change.
2. `finding` for each remark, `reply` into existing threads,
   `resolve`, `react`, `verdict` for the position.
3. `plan` to see exactly what publishing will do.
4. `publish`.

**Always plan before publishing, and say what will degrade
before the user finds out from the result.** The plan names
what will land where it was aimed, what will land somewhere
else and why, and what cannot land at all. A remark whose
anchor is not in the diff spills into the body; a batch too
large for the server is refused up front.

Publishing keeps whatever did not land, so a retry sends
only the remainder. Say so when something fails, rather than
letting a second attempt look like it duplicated the first.

## Threads Are Named by Index

Refer to a thread by the `[T#]` index the threads listing
shows. Never invent or guess a thread id: the backends key
them differently, and one keys a reply by the comment that
started the exchange rather than by the thread.

## Every Write Asks First

Anything that changes somebody else's change opens a
confirmation gate. Describe what you are about to post
before calling it, so the gate confirms a decision the user
already understands rather than presenting them with one.

Without a UI the gate approves, so a tool running inside a
subagent has nobody to ask. Do not rely on the gate as the
only thing standing between a draft and a stranger's change.

## Reads Degrade, Writes Refuse

A read that loses part of its answer reports the part it
lost and returns the rest. A write that cannot be performed
correctly refuses rather than performing something close.

Follow the same rule in what you say. "Thirty-four threads,
and who resolved them could not be read" is useful. "Thirty
four threads" when the resolvers were silently dropped is
not.
