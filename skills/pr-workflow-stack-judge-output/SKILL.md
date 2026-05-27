---
name: pr-workflow-stack-judge-output
description: >
  Output contract for stack-wide judge subagents in
  pr-workflow. The JSON shape with per-PR and cross-PR
  findings, attribution fields, optional self-signal,
  membership rules, and the verify_output self-check
  protocol. Loaded into each stack-judge subagent via
  --skill.
---

# Stack-judge output

Reply with a single fenced JSON block. No prose outside
the block.

## Top-level shape

```
{
  "selfSignal": { ... },          // optional
  "perPr": {
    "<prNumber>": [ <Finding>, ... ],
    ...
  },
  "crossPr": [ <CrossFinding>, ... ]
}
```

## perPr

- Keys are PR numbers encoded as strings (e.g. `"101"`,
  `"205"`). They must match the pattern `/^[1-9][0-9]*$/`.
- Include **every** PR in the stack as a key, using an
  empty array `[]` when that PR has no findings.
- Each consolidated finding carries the round-2 core
  shape: `location`, `label`, `subject`, `discussion`,
  plus the optional `decorations`, `severity`,
  `confidence`, `threadRelation` fields.
- Add optional `raisedBy` (round-1 reviewer ids) and
  `sourceFindingIds` (round-1 finding ids) to record
  attribution. Omit both when the finding is judge
  synthesis.

## crossPr

True cross-PR consolidated findings only. Each carries:

- The core finding fields.
- `homePrNumber` — the PR where this finding should post.
- `spans` — non-empty array of PR numbers the finding
  refers to.
- Optional `raisedBy` and `sourceFindingIds` as above.

## Membership rule

A finding under PR #101 must stay under `perPr["101"]`
unless it truly spans multiple PRs, in which case it
belongs in `crossPr`. Don't promote a per-PR finding to
cross-PR just because more than one reviewer surfaced it.

## Synthesize, do not concatenate

Similar findings from multiple reviewers become one
consolidated finding with `raisedBy` and
`sourceFindingIds`. Don't list every reviewer's wording
separately.

## Self-signal

Optional. When present, `selfSignal.rationale` must
contain non-whitespace prose: a concrete explanation of
your confidence. Blank rationales fail verification.

## Self-verify before ending

The subagent has access to the `verify_output` tool from
the `pr-workflow-stack-judge-verify` extension. Before
finishing your run:

1. Call `verify_output` with `output` set to the object
   you intend to emit (pass the object itself, not a
   stringified copy).
2. The tool returns `ok: true` with the parsed item count,
   or `ok: false` with a list of
   `{path, message, hint}` errors.
3. If errors are reported, fix the offending fields and
   call `verify_output` again.
4. Only emit your final fenced JSON block (and end the
   run) once the verifier returns `ok: true`.

If the verifier keeps reporting the same error after three
attempts, emit your best attempt and the parent will
surface the warnings.
