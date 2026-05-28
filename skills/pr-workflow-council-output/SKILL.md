---
name: pr-workflow-council-output
description: >
  Output contract for round-1 council reviewer subagents in
  pr-workflow. The JSON shape of findings, location kinds,
  thread-relation fields, and the verify_output self-check
  protocol. Loaded into each reviewer subagent via --skill.
---

# Round-1 council reviewer output

Reply with a single fenced JSON block. No prose outside the
block. If you have nothing to flag, return
`{"findings": []}`.

## Top-level shape

```
{ "findings": [ <Finding>, ... ] }
```

Each `Finding` must include:

- `location` — see [Location kinds](#location-kinds).
- `label` — a Conventional Comments label: `praise`,
  `nitpick`, `suggestion`, `issue`, `todo`, `question`,
  `thought`, `chore` or `note`.
- `subject` — a short headline.
- `discussion` — concrete prose explaining the concern,
  citing the code you saw and the user, backend or
  operational impact.

Optional decorations:

- `decorations` — free-form short tags
  (e.g. `"non-blocking"`, `"if-minor"`).
- `severity` — `"critical"`, `"medium"` or `"minor"`. The
  parent process also accepts the common aliases
  `"required"`/`"blocking"`/`"high"` (mapped to
  `"critical"`) and
  `"non-blocking"`/`"nice-to-have"`/`"info"`/`"low"`
  (mapped to `"minor"`); unknown values are dropped with
  a warning rather than rejecting the finding. Use the
  canonical set when you can.
- `confidence` — a number 0.0 to 1.0.
- `threadRelation` — see
  [Existing review threads](#existing-review-threads).

## Location kinds

- `"line"` — has `file`, `start`, `end` and
  `side`: `"old"` | `"new"` | `"both"`. Anchor only to
  lines that appear in the PR diff hunks; the prompt
  lists the anchorable line ranges per file under
  **Anchorable line ranges**. Each row reads:

  ```
  path/to/file.ts: new 12-34, 50-78 | old 12-34
  ```

  The `new ...` ranges are valid line numbers on the
  right side of the diff (added or context lines, set
  `side: "new"`). The `old ...` ranges are valid on the
  left side (removed or context lines, set
  `side: "old"`). Either segment is omitted when that
  side has no anchorable lines. The parent process warns
  when a line finding falls outside the listed ranges —
  the finding survives but will silently degrade to a
  body comment unless the user fixes the range. Stale
  line numbers and lines outside any hunk are not valid
  anchors.
- `"file"` — has `file` only.
- `"global"` — PR-level finding, no `file`.

## Existing review threads

When your finding relates to a `[T#]` thread surfaced in
the prompt, set `threadRelation`:

- `kind: "duplicates-existing"` — drop the finding because
  `[T#]` already covers it.
- `kind: "supports-existing"` — fresh evidence that
  substantiates `[T#]`.
- `kind: "disputes-existing"` — fresh evidence that
  disproves `[T#]`.
- `kind: "amplifies-existing"` — fresh evidence that
  accentuates `[T#]`.

In each case, include `threadIndex` (the numeric T index)
and a short `rationale`. Omit `threadRelation`, or use
`kind: "new"`, when no existing thread is relevant.

## Self-verify before ending

The subagent has access to the `verify_output` tool from
the `pr-workflow-council-verify` extension. Before
finishing your run:

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
