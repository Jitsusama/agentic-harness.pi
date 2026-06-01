---
name: github-issue-format
description: >
  Issue body structure and narrative. The closed three-section
  body (Situation, Outcome, Acceptance), URI indexing and title
  conventions. Use when writing or editing a GitHub issue.
  Pairs with github-cli-convention for command syntax and
  markdown-standard for markdown structure. Follow the user's
  writing voice and prose style guides for issue text.
---

# Issue Writing

An issue is a contract between the person requesting work and
the person doing it. It needs to be clear enough that someone
unfamiliar with the context can understand what needs to
happen, why it matters and how to know when it's done.

This skill governs the shape and prose of an issue body. Follow
`prose-standard` for voice and `markdown-standard` for markdown
structure; see `github-cli-convention` for the command surface.

## Title

- Describe the outcome, not the task.

See `github-cli-convention` for title formatting rules
(Title Case, length, formula).

## Body Structure

An issue body has exactly three sections, in this order. Each
heading is the emoji and the name together, written precisely as
shown. These three are the whole set; there are no optional
sections and no others. An issue describes a problem to solve:
what is wrong, what "done" looks like and how we will know it is
done. An issue is the mirror of a PR told before the work: where
a PR has a Resolution and a Validation, an issue has only a
target and the criteria that will prove it. Deferred or related
work is a separate, linked issue, not a heading here.

### 🌐 Situation

The problem and its context. What is wrong, what is missing,
what is hurting, and why it matters. This is the same in spirit
as a PR's Situation: the problem does not change whether you
describe it before the work or after. Name the scenario, the
failure mode or the gap concretely enough that a reader with no
context understands the stakes.

### 🎯 Outcome

What "done" looks like, described as a destination rather than a
plan. The desired end state in plain terms: "an operator can
cancel a run and recover the partial records." Name the target,
not the route. How the work gets there is the PR's Resolution,
written later; the issue states only where it needs to arrive.

### ✅ Acceptance

The concrete, checkable criteria that prove the outcome was
reached. This is the issue's forward-looking analogue of a PR's
Validation: not evidence you have, but the checklist that will
become that evidence. Each criterion is specific enough to test:
"cancelling a run drains the inflight operations; a test pins
the contract; the partial store renders." When the PR that
closes this issue lands, its Validation answers this Acceptance.
Avoid vague criteria like "works correctly."

The three answer, in order: what is wrong, what "done" looks
like, how we will know. Anything that is none of those three
does not belong in the body.

## URI Indexing

Every URI in the body is a markdown reference link, never a raw
inline URL. Inline, write `[descriptive label][1]`; in a footer
block at the end of the body, write `[1]: https://...` on its
own line. The label is descriptive prose the reader scans, not
"here" or "this link". See `markdown-standard` for the full
reference-link convention.

## Worked Example

```markdown
### 🌐 Situation

Cancelling a running benchmark returns immediately, but the
operations already in flight on the worker pool never finish
writing their records. Operators who cancel a long run lose the
partial results they expected to keep, and the remote streams
stay open waiting for envelopes that never arrive.

### 🎯 Outcome

Cancelling a run drains the inflight operations cleanly. The
records that completed before the cancel reach the store, and
the operator can render a report over the partial run.

### ✅ Acceptance

A cancel drains the inflight operation set before the run
returns. A test pins the drain contract on the public surface.
The report renderer accepts a partial run and names it as
cancelled. The full suite passes.
```

The Situation names the problem and the stakes. The Outcome
names the destination without prescribing the route. The
Acceptance lists criteria specific enough to check.

## After Creating

Immediately after `gh issue create`, always run:

```bash
gh issue edit NUMBER --add-assignee @me
```

This is not optional. Every issue must have an assignee.

## CLI Format

See `github-cli-convention` for command syntax: heredoc
patterns, `--body-file -` and metadata in separate commands.

## What Not to Do

- Don't add sections beyond the three. The set is closed:
  🌐 Situation, 🎯 Outcome, ✅ Acceptance. No Background,
  Proposal, Tasks or Notes heading. Related work is a separate
  linked issue; links go in the URI footer.
- Don't change the heading shape. The headings are `### 🌐
  Situation`, `### 🎯 Outcome`, `### ✅ Acceptance`, exactly:
  the emoji, the name, at the `###` level.
- Don't hard-wrap body paragraphs; GitHub reflows them, and hard
  breaks make the text choppy. Write each paragraph as a single
  continuous line.
- Don't write an implementation plan in the Outcome; name the
  destination, not the route. The plan belongs in the PR.
- Don't use vague acceptance criteria like "works correctly."
- Don't combine unrelated work in a single issue.
- Don't inline a raw URL; every link is a reference into the URI
  footer.
