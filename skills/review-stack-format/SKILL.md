---
name: review-stack-format
description: >
  Output contract for a reviewer in a review_ask stack round.
  The council finding shape plus the refs field that says which
  changes a finding is about, and why a cross-change finding
  stays one finding. Loaded into each subagent via --skill.
---

# What a Stack-Wide Reviewer Answers With

The council finding shape with one field added: `refs`, naming the
changes each finding is about. Answer with one JSON object.

```json
{
  "findings": [
    {
      "refs": ["refs/heads/base", "refs/heads/tip"],
      "label": "issue",
      "subject": "the base's contract is broken at the tip",
      "discussion": "...",
      "location": { "kind": "file", "file": "lib/a.ts" }
    }
  ]
}
```

Every other field is as [`review-council-format`](../review-council-format)
describes it, including the three location kinds, the label set and what
happens to a field that will not read.

## Write Each One Down When You Find It

When a `record_finding` tool is available, call it the moment you are
sure of a finding, with that one finding and its `refs`, and carry on.
Then include everything in your final answer as normal. A stack round
reads several changes at once, so it is the longest round there is, and
an answer that never arrives takes every finding in it.

A recorded finding without `refs` cannot be placed and is dropped, the
same as one in your answer would be, so record the refs with it rather
than meaning to add them later.

## Naming the Changes

`refs` holds the refs the prompt listed, exactly as written. One ref for
an ordinary finding about one change. Several for a finding that only
exists between changes.

A ref the stack does not hold is left out with a warning, and the
finding survives on the refs that remain: naming three changes and
getting one wrong does not throw away what you saw about the other two.
A finding naming no known ref is dropped, because nobody can place it.

You do not control the order. Refs come back sorted the way the stack
applies, so listing them tip-first costs nothing.

## A Cross-Change Finding Stays One Finding

Do not repeat one observation against each change it touches. It makes
whoever reads it answer the same thing three times, leaves three places
to resolve it, and loses the only thing that made it worth saying: that
it is *between* them.

One finding, several refs. It is filed once, at the earliest change it
names, because that is where the decision was made and where a reader
walking the stack meets it first.

## Review Each Change On Its Own Too

A stack pass that reports only cross-change findings is half a review.
Most of what is wrong with a stack is wrong with one change in it.

## Check Whether a Later Change Fixes It

This is the mistake a per-change pass cannot make and a stack pass makes
constantly. A change that looks wrong on its own is often corrected two
changes up. Look before you report it, and if the fix arrives later than
it should, that is itself the finding: name both refs and say so.
