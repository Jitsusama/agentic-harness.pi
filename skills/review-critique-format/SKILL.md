---
name: review-critique-format
description: >
  Output contract for a critic in a review_ask critique round.
  The JSON shape of a position on a finding, the four position
  words, and why a bare vote is dropped. Loaded into each
  critique subagent via --skill.
---

# What a Critic Answers With

A critique records **positions, not findings**. You are not reviewing
the change; you are weighing what the judge concluded about it. Answer
with one JSON object.

```json
{
  "critiques": [
    { "findingId": 3, "position": "disagree", "rationale": "..." }
  ]
}
```

## What a Position Carries

| Field | Required | What it is |
|---|---|---|
| `findingId` | yes | The number the finding was given |
| `position` | yes | `agree`, `disagree`, `qualify` or `unsure` |
| `rationale` | yes | Why, in your own words |

`findingId` must be one of the numbers the prompt put to you. A position
on a finding nobody raised is dropped with its id named, because it is
more likely a misread than information.

## The Four Positions

- **`agree`** the finding holds as stated.
- **`disagree`** it does not. Say what is wrong with it, not that you
  would have said it differently.
- **`qualify`** it holds, but not as broadly as stated, or not for the
  reason given. This is the most useful one and the most neglected.
- **`unsure`** you cannot settle it from what is here. A real answer,
  and better than picking a side to look decisive.

## A Bare Vote Is Dropped

A position with no `rationale` is discarded, not recorded as a weak
signal. A vote nobody can weigh against the finding it disputes adds
nothing a reader can act on, and counting it would let a critic move a
finding's standing without making an argument.

## Silence Is Not Assent

Say nothing about a finding and you have taken **no position** on it. It
is never read as agreement. If it were, a critic that ran out of budget
halfway through would manufacture consensus, and a weakly supported
finding would come out of the round looking corroborated.

So there is no cost to leaving a finding alone, and no need to fill in
`agree` on everything you did not examine. Examine what you can argue
about and be silent on the rest.
