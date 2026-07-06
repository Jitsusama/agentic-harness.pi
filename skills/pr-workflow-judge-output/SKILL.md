---
name: pr-workflow-judge-output
description: >
  Output contract for round-2 judge subagents in
  pr-workflow. The JSON shape of consolidated findings,
  attribution fields, the optional self-signal, and the
  verify_output self-check protocol. Loaded into each
  judge subagent via --skill.
---

# Round-2 judge output

Reply with a single fenced JSON block. No prose outside
the block.

## Top-level shape

```
{
  "selfSignal": { ... },        // optional
  "findings":   [ <Finding>, ... ]
}
```

## Findings

Each consolidated `Finding` carries the same core shape as
round 1:

- `location`, `label`, `subject`, `discussion` — required.
- `decorations`, `severity`, `confidence` — optional.
- `recommendation` — optional but strongly preferred: one
  short, decision-oriented clause telling the reviewing user
  what to do about the finding (for example "fix before
  merge", "safe to defer", "confirm intent with the
  author"). Keep it distinct from `discussion`, which
  describes the problem, not the action.

### Location preservation

When the round-1 findings you are consolidating all
anchor to specific lines in the same file, your
consolidated finding's location must be `"line"` with
`start`/`end` covering the source range. Collapsing to
`"file"` discards the specificity GitHub needs to post
inline and the parent process will restore the broadest
line span from sources automatically; collapsing to
`"global"` is taken as deliberate ("this is
scope-wide"). Only choose `"file"`-kind when the
sources genuinely disagree on where the issue lives.

The judge adds two optional attribution fields:

- `raisedBy` — list of round-1 reviewer ids that surfaced
  this point. Omit when the judge surfaced the finding on
  its own.
- `sourceFindingIds` — round-1 finding ids you
  consolidated. Omit when the finding is judge synthesis.

When a finding substantiates, disputes or amplifies an
existing `[T#]` thread, preserve its `threadRelation`.
Drop findings that merely duplicate an existing thread
unless you carry new evidence the author should see.

## Self-signal

Optional. When present, `selfSignal.rationale` must
contain non-whitespace prose: a concrete explanation of
your confidence. Blank rationales fail verification.

## Synthesize, do not concatenate

Similar findings from multiple reviewers become one
consolidated finding with `raisedBy` and
`sourceFindingIds`. Don't list every reviewer's wording
separately.

## Self-verify before ending

The subagent has access to the `verify_output` tool from
the `pr-workflow-judge-verify` extension. Before finishing
your run:

1. Call `verify_output` with `output` set to the object
   you intend to emit (pass the object itself, not a
   stringified copy).
2. The tool returns `ok: true` with the parsed finding
   count, or `ok: false` with a list of
   `{path, message, hint}` errors.
3. If errors are reported, fix the offending fields and
   call `verify_output` again.
4. Only emit your final fenced JSON block (and end the
   run) once the verifier returns `ok: true`.

If the verifier keeps reporting the same error after three
attempts, emit your best attempt and the parent will
surface the warnings.
