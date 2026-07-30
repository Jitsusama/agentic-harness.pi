---
name: review-council-format
description: >
  Output contract for a discovery reviewer in a review_ask
  council round. The JSON shape of a finding, the three
  location kinds, and what happens to each field that will
  not read. Loaded into each reviewer subagent via --skill.
---

# What a Discovery Reviewer Answers With

Answer with one JSON object. Prose outside it is ignored, and prose
instead of it loses your whole pass. With nothing to say, answer
`{"findings": []}` rather than explaining that you found nothing.

```json
{ "findings": [ { "...": "one finding" } ] }
```

## What a Finding Carries

| Field | Required | What it is |
|---|---|---|
| `location` | yes | Where the finding points. See below |
| `label` | yes | A Conventional Comments label |
| `subject` | yes | One line naming the finding |
| `discussion` | no | The argument, and what it costs |
| `severity` | no | `critical`, `medium` or `minor` |
| `confidence` | no | A number from 0 to 1 |
| `raisedBy` | no | Reviewer ids, when you are consolidating |

`label` is one of `praise`, `nitpick`, `suggestion`, `issue`, `todo`,
`question`, `thought`, `chore`, `note`. Nothing else is accepted, and a
finding labelled anything else is dropped: guessing a label would put
words in your mouth.

`severity` also accepts the words models reach for instead. `blocking`,
`required` and `high` read as `critical`; `low`, `non-blocking`,
`nice-to-have` and `info` read as `minor`. Prefer the canonical three.

## The Three Location Kinds

```json
{ "kind": "line", "file": "lib/a.ts", "start": 12, "end": 18, "side": "new" }
{ "kind": "file", "file": "lib/a.ts" }
{ "kind": "global" }
```

`end` defaults to `start`, and `side` defaults to `new`. Anchor a line
finding only inside the ranges the prompt lists as anchorable: a line
outside them is not in the diff, so the change carries nowhere to hang
the remark and it degrades to prose.

Reach for `file` when the observation is about the file rather than a
line, and `global` when it is about the change as a whole. A `global`
finding is not a lesser finding. An argument about the shape of the
change belongs there, and forcing it onto an arbitrary line makes it
read as a remark about that line.

## What Happens To What Will Not Read

One bad entry costs one finding, never the batch, and the grading is
deliberate:

- A missing `subject`, a bad `label` or an unusable `location` **drops
  the finding**. Each of those is load-bearing, and inventing one puts
  words in your mouth.
- A bad `severity`, `confidence` or `raisedBy` **drops only itself**.
  The observation is the value; those are decoration.

Every drop comes back as a warning naming the entry, so a malformed
answer is visible rather than silently smaller.

## What Makes a Finding Worth Reading

Your pass is for discovery. Another consolidates and a third pushes
back, so a finding you are unsure of is still worth raising as long as
the uncertainty arrives with the evidence that would settle it. Put
that in `confidence` and say so in `discussion`.

Go and read the code. A finding grounded in something you opened is
worth ten that restate the diff, and a finding that only restates the
diff wastes the author's time twice: once reading it and once saying so.
