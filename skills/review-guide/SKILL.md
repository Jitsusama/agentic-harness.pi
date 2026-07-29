---
name: review-guide
description: >
  How to read and review a change through the `review`,
  `review_stack`, `review_thread` and `review_draft` tools,
  whatever system hosts it: GitHub, Meteorite, a GitLab
  merge request, or a range of commits nobody has proposed
  at all. Covers resolving a reference, reading a diff and a
  conversation, judging a stack by its provenance, composing
  a review as a draft, planning what publishing will do, and
  reporting degradation honestly. Use when asked to "review
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

| Tool | For |
|---|---|
| `review` | Resolve, view, diff, checks, list, capabilities |
| `review_stack` | The stack a change sits in |
| `review_thread` | Reviews, threads, messages, reply, resolve, react, comment |
| `review_draft` | Compose a review, plan it, publish or render it |

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
provider can do before offering it. A facet that is absent
is absent on purpose: it means the provider cannot do that
thing, not that it forgot to say so.

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
