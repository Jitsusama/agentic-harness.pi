---
name: review-finding-format
description: >
  The shape of one finding in every review_ask round that answers
  with findings (council, judge and stack): its fields and labels,
  the three location kinds, and what happens to a field that will
  not read. Loaded beside the round's own contract via --skill.
---

# What One Finding Carries

A finding is one JSON object with these fields and no names of your
own. The round's own contract says what wraps them and what it adds.

| Field | Required | What it is |
|---|---|---|
| `location` | yes | Where the finding points. See below |
| `label` | yes | A Conventional Comments label |
| `subject` | yes | One line naming the finding |
| `discussion` | no | The argument, and what it costs |
| `severity` | no | `critical`, `medium` or `minor` |
| `confidence` | no | A number from 0 to 1 |
| `raisedBy` | no | Reviewer ids, when you are consolidating |

```json
{
  "location": { "kind": "line", "file": "lib/a.ts", "start": 12 },
  "label": "issue",
  "subject": "the retry asks the judge with the council's contract",
  "discussion": "...",
  "severity": "medium"
}
```

A prompt may show you findings written another way, such as
`[F3] reviewer · issue · lib/a.ts:12`. That is how they are shown to
you, not how you answer: answer in the fields above whatever the
prompt's own layout uses. `category`, `title` and `body` are not
fields of a finding, and `file` and `line` go inside `location`, never
beside it.

`label` is one of `praise`, `nitpick`, `suggestion`, `issue`, `todo`,
`question`, `thought`, `chore`, `note`. Use one of those. A finding
labelled anything else is kept as a `note` with your own word named in a
warning, since guessing what you meant would put words in your mouth and
throwing the remark away would lose it entirely.

`severity` says how much it matters, never what kind of remark it is:
a label word there is not a severity. It also accepts the words models
reach for instead. `blocking`, `required` and `high` read as
`critical`; `low`, `non-blocking`, `nice-to-have` and `info` read as
`minor`. Prefer the canonical three.

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
