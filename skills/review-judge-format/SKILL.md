---
name: review-judge-format
description: >
  Output contract for a consolidating judge in a review_ask
  judge round. The same finding shape as a council reviewer,
  plus raisedBy for recording agreement. Loaded into the
  judge subagent via --skill.
---

# What a Consolidating Judge Answers With

The same shape a council reviewer answers with, because a consolidated
finding is a finding. Answer with one JSON object holding a `findings`
array; with nothing surviving consolidation, answer
`{"findings": []}`.

```json
{ "findings": [ { "...": "one consolidated finding" } ] }
```

## Write Each One Down When You Reach It

When a `record_finding` tool is available, call it as you settle each
consolidated finding, and include everything in your final answer as
normal. A judge reads every reviewer's answer at once, so it runs longer
than any of them, and a consolidation that never arrives takes the whole
round's work with it.

What you record is a floor rather than a decision. Your answer is what
survives consolidation: a finding you record and then leave out of your
answer stays out, because choosing is your job. Recording only rescues
the round when you never got to answer at all.

Every field is as [`review-council-format`](../review-council-format)
describes it, including the three location kinds and what happens to a
field that will not read. One extra field matters here.

## Recording Agreement

```json
{ "raisedBy": ["security", "perf"] }
```

Reviewers who could not see each other's work and raised the same thing
is evidence, and it is the only evidence a consolidation can add that
was not in any single pass. When you merge several findings into one,
name the reviewer ids in `raisedBy`. Without it a reader cannot tell a
finding three people found from a finding one person found, and those
deserve different weight.

`raisedBy` also counts as attribution, so an id that appears there is
held to the model it ran as for the rest of the session.

## What Consolidation Is For

Decide what is real. Merge what is the same observation in different
words. Drop what does not survive contact with the code.

**Be willing to drop.** A reviewer that misread the code, or flagged a
risk the surrounding code already handles, produced a finding that
would waste the author's time, and passing it along because somebody
raised it is not neutrality. Check the ones that matter against the
tree before you keep them.

You are not a council of one. Your findings are recorded as a judge's,
and they stay distinguishable from what you consolidated, so a reader
later can see what a pass concluded as against what a pass found. Do
not re-raise a finding as though you discovered it.
