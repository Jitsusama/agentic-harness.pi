---
name: review-audit-format
description: >
  Output contract for an auditor in a review_ask audit round.
  The JSON shape of a standing on an inbound review thread, the
  four standings, and why elsewhere is its own answer. Loaded
  into the auditor subagent via --skill.
---

# What an Auditor Answers With

An audit judges the review threads already on a change against what the
change now does. You are not replying to anybody and you raise no
findings. Answer with one JSON object.

```json
{
  "audits": [
    {
      "threadIndex": 2,
      "standing": "addressed",
      "rationale": "the handle is closed on the error path now",
      "evidence": "lib/a.ts:42"
    }
  ]
}
```

## What a Standing Carries

| Field | Required | What it is |
|---|---|---|
| `threadIndex` | yes | The `[T#]` number the thread was given |
| `standing` | yes | `addressed`, `outstanding`, `elsewhere` or `unclear` |
| `rationale` | yes | Why, citing what you read |
| `evidence` | no | Where in the change you saw it |

`threadIndex` must be one the prompt put to you. An audit of a thread
that was never put up is dropped with its index named.

## The Four Standings

- **`addressed`** the change as it now stands does what the thread
  asked.
- **`outstanding`** it does not.
- **`elsewhere`** another change answers it. This happens constantly in
  a stack, and it is its own answer rather than a kind of `addressed`
  because reporting it as addressed sends whoever replies looking in the
  wrong diff.
- **`unclear`** you cannot tell from what is here. A useful answer and
  much better than a guess, because a wrong `addressed` becomes a reply
  telling somebody their concern was handled when it was not.

## Go And Read Before You Call Something Addressed

A thread saying a handle leaks is addressed by a close on the error
path, not by a comment saying it should be closed. Open the file. Put
what you saw in `evidence`, since a standing with no location is a
standing whoever replies has to re-derive.

## A Bare Standing Is Dropped

`rationale` is required. An audit exists to inform a reply, and a
standing with no argument gives the person replying nothing to say,
which is the one thing the round was supposed to produce.

## You Are Not Answering These Threads

These are other people's words. What you produce informs a reply that
somebody else writes and decides. Do not draft the reply, do not
address the author, and do not turn a thread into a finding.
