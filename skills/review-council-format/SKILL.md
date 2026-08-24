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

## Write Each One Down When You Find It

When a `record_finding` tool is available, call it the moment you are
sure of a finding, with that one finding, and carry on. Then include
everything in your final answer as normal.

This is not bookkeeping. A review can be interrupted, by a deadline or
by the provider, and an answer that never arrives takes every finding
in it. Rounds have been lost that way after ten minutes of real work.
What you have recorded survives that; what you were saving for the end
does not.

So record early and record often. Do not batch them up to record at the
end, which is the failure this avoids, wearing a different hat. A
finding recorded and then repeated in your answer is counted once, so
repeating costs nothing and leaving it out risks everything.

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
`question`, `thought`, `chore`, `note`. Use one of those. A finding
labelled anything else is kept as a `note` with your own word named in a
warning, since guessing what you meant would put words in your mouth and
throwing the remark away would lose it entirely.

`severity` also accepts the words models reach for instead. `blocking`,
`required` and `high` read as `critical`; `low`, `non-blocking`,
`nice-to-have` and `info` read as `minor`. Prefer the canonical three.

## The Three Location Kinds

```json
{ "kind": "line", "file": "lib/a.ts", "start": 12, "end": 18, "side": "new" }
{ "kind": "file", "file": "lib/a.ts" }
{ "kind": "global" }
```

`end` defaults to `start`, `line` is read as `start` for a single line,
and `side` defaults to `new`. Anchor a line
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

- A missing `subject` **drops the finding**, because there is no
  observation left to keep.
- A bad `label` **costs the label**. The finding is kept as a `note`
  with your own word named in its discussion, since inventing what you
  meant would put words in your mouth and discarding the remark would
  lose it entirely.
- An unusable `location` **costs precision, not the remark**. A line
  with no line falls back to the file, a file with no file to the
  change.
- A bad `severity`, `confidence` or `raisedBy` **drops only itself**.
  The observation is the value; those are decoration.

Every one of those comes back as a warning naming the entry, so an
answer that needed forgiving is visible rather than silently different.
A warning does not mean something was dropped: read the warning to see
what it cost.

## What Makes a Finding Worth Reading

Your pass is for discovery. Another consolidates and a third pushes
back, so a finding you are unsure of is still worth raising as long as
the uncertainty arrives with the evidence that would settle it. Put
that in `confidence` and say so in `discussion`.

Go and read the code. A finding grounded in something you opened is
worth ten that restate the diff, and a finding that only restates the
diff wastes the author's time twice: once reading it and once saying so.

A symptom you observed may be reported on the observation alone. A
mechanism, the *because* clause, must quote the responsible code to a
file and line, and a mechanism you have not found is a question, not
a claim held at severity. A confident causal narrative unsupported by
source reads as diagnosis and sends the author to fix the wrong line,
which costs more than the finding was worth.
