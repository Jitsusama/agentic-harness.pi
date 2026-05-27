---
name: pr-workflow-critique-output
description: >
  Output contract for round-3 critique reviewer subagents
  in pr-workflow. The JSON shape of critique entries,
  position vocabulary, rationale requirements, and the
  verify_output self-check protocol. Loaded into each
  critique reviewer subagent via --skill.
---

# Round-3 critique output

Reply with a single fenced JSON block. No prose outside
the block.

## Top-level shape

```
{ "critiques": [ <CritiqueEntry>, ... ] }
```

Each `CritiqueEntry` has:

- `findingId` — the consolidated finding's id from the
  judge's round-2 output.
- `position` — one of `agree`, `disagree`, `qualify` or
  `amplify`.
- `rationale` — one to two sentences. Must contain
  non-whitespace prose: blank rationales fail
  verification.

## What a good rationale says

The rationale should name **evidence**, not opinion:

- What did you find in the worktree that proves the
  finding?
- What did you find that disproves it?
- Does the finding merely repeat an existing thread
  (e.g. `[T3]`)?

A vague "I agree" or "looks fine" rationale is
unacceptable. Be specific.

## Self-verify before ending

The subagent has access to the `verify_output` tool from
the `pr-workflow-critique-verify` extension. Before
finishing your run:

1. Call `verify_output` with `output` set to the object
   you intend to emit (pass the object itself, not a
   stringified copy).
2. The tool returns `ok: true` with the parsed entry
   count, or `ok: false` with a list of
   `{path, message, hint}` errors.
3. If errors are reported, fix the offending fields and
   call `verify_output` again.
4. Only emit your final fenced JSON block (and end the
   run) once the verifier returns `ok: true`.

If the verifier keeps reporting the same error after three
attempts, emit your best attempt and the parent will
surface the warnings.
