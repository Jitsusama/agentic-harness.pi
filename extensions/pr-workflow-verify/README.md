# pr-workflow-verify

Sibling extension to `pr-workflow`. Registers a single
tool, `verify_output`, that reviewer subagents call to
self-validate their JSON output against the same TypeBox
schema the parent will parse against.

Without this, a reviewer subagent finishes its turn,
emits malformed JSON, and the parent silently drops the
finding (or the whole batch). The reviewer never knows.
With this, the subagent calls `verify_output` before
ending, sees structured `{path, message}` errors, fixes
its output, and only emits the final fenced JSON block
once the verifier returns `ok: true`.

## How It's Loaded

The extension is not auto-discovered. The parent
pr-workflow extension resolves the absolute path to this
extension's entry point (`extensions/pr-workflow-verify/index.ts`)
and passes it to every reviewer subagent via the
`--extension <path>` CLI flag. Pi loads the extension at
subagent startup, registers `verify_output`, and the
subagent's prompt instructs it to call the tool before
ending.

See `extensions/pr-workflow/verify-path.ts` for the
path-resolution helper and `extensions/pr-workflow/index.ts`
for the wiring (search for `extraExtensions`).

## Schema Source

Schemas live in `../pr-workflow/schemas.ts`, the single
source of truth for all three reviewer stages:

- `CouncilFindingsOutput` (round 1)
- `JudgeOutput` (round 2)
- `CritiqueOutput` (round 3)

The verify tool dispatches by `stage` name and uses
`Value.Check` from `@sinclair/typebox/value` to validate.
Anything the verifier accepts here, the parent parser
accepts there. No drift.

## Tool Contract

```
verify_output({
  stage: "council" | "judge" | "critique",
  output: <unknown JSON-shaped value>
})
```

Returns one of two shapes via `details`:

```
{ ok: true, count: <number of validated entries> }
```

or

```
{
  ok: false,
  errors: [
    { path: "/findings/0/label", message: "..." },
    ...
  ]
}
```

The `path` strings follow TypeBox's JSON Pointer format
so the model can correlate each error to the offending
field in the output it just submitted.

On failure, the tool result is marked `isError: true`
so pi's TUI renders it as a tool error, prompting the
model to retry rather than continuing as if the call
succeeded.

## Design Choices

- **Pure validator, no side effects.** The tool reads
  the schema registry and returns a verdict. It does
  not touch the filesystem, the parent's state, or the
  network.
- **Structural only (phase 1).** Validates field
  presence, types, vocabulary membership, integer
  ranges. Does NOT check that a finding's `file` is in
  the PR diff or that line numbers fall in a hunk.
  Phase-2 diff-aware semantic checks are on hold
  pending real-world failure signal.
- **No retry budget here.** The subagent's prompt asks
  it to retry up to three times before giving up; this
  extension just answers each call. Counting attempts
  is the model's job.

## Why a Separate Extension

Three reasons:

1. **Subagent isolation.** Subagents inherit only what
   they're spawned with. The parent loads its own
   panels, gates and tool surface; the subagent gets a
   minimal extension that does one thing.
2. **Composition.** Future verify-style extensions
   (cost-cap, time-budget, output-size) drop in next to
   this one without touching pr-workflow.
3. **Restart granularity.** Editing this file in
   isolation lets `/reload` pick up the change without
   touching the parent.

## Companion Files

- `index.ts` — the extension entry; registers
  `verify_output` via `pi.registerTool`.
- `src/validate.ts` — pure `validateOutput(stage, input)`
  helper. Pi-agnostic; can be unit-tested without
  loading the extension.

Tests live in `tests/extensions/pr-workflow-verify/`.
