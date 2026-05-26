---
name: pr-workflow-stack-review-output
description: >
  Output contract for stack-wide reviewer subagents in
  pr-workflow. The JSON shape with per-PR and cross-PR
  findings, perPr key rules, cross-PR span fields, and the
  verify_output self-check protocol. Loaded into each
  stack-review reviewer subagent via --skill.
---

# Stack-review output

Reply with a single fenced JSON block. No prose outside
the block.

## Top-level shape

```
{
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
- Each finding has the same core shape as round 1:
  `location`, `label`, `subject`, `discussion`, plus the
  optional `decorations`, `severity`, `confidence`,
  `threadRelation` fields.

## crossPr

True cross-PR observations only. A finding belongs in
`crossPr` when its reasoning spans multiple PRs in the
stack and can't be expressed under any single PR.

Each cross-PR finding has:

- The core finding fields (`location`, `label`, `subject`,
  `discussion`, etc.).
- `homePrNumber` — the PR where this finding should post.
- `spans` — non-empty array of PR numbers (integers, e.g.
  `[248, 250]`) the finding refers to.

## Discipline

Walk each PR in order. Before moving to the next PR,
decide every finding that belongs to the current PR and
place it under `perPr["<number>"]`. After the last PR, add
only true cross-PR observations under `crossPr`.

## Self-verify before ending

The subagent has access to the `verify_output` tool from
the `pr-workflow-stack-review-verify` extension. Before
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
