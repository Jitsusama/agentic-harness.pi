# Subagent

A small engine for running pi as a child process.

Each subagent is its own pi run (`pi --mode json --no-session
-p ...`) with its own context window, working directory and
tool palette. The library composes the args, watches the
JSON stream and surfaces tokens, costs, warnings and verify
outcomes back to the parent. It is the substrate underneath
the pr-workflow council and the future
`subagent-workflow` extension.

## Public surface

Two ways to call the engine:

```ts
import { runSubagent } from "agentic-harness.pi/subagent";

const result = await runSubagent({
  spec: { id: "fast", model: "claude-haiku-4-7" },
  job: { userPrompt: "Summarise this PR", cwd: "/tmp/wt" },
  runPi,
});
```

```ts
import { runFleet } from "agentic-harness.pi/subagent";

const { results } = await runFleet({
  assignments: specs.map((spec) => ({ spec, job })),
  runPi,
});
```

`SubagentJob` captures the work; `SubagentSpec` captures
the role. `runPi` is the runtime (`createSpawnRunPi` for
fire-and-forget, `createSupervisorRunPi` for durable runs
with crash recovery). The legacy `runReviewer` shape (one
flat options bag, used by pr-workflow's existing
callsites) remains exported during the migration.

## Always-load defaults

The engine keeps a process-global registry of extensions
and skills that should be present in every subagent run:

```ts
import {
  registerSubagentDefaultExtension,
  registerSubagentDefaultSkill,
} from "agentic-harness.pi/subagent";

registerSubagentDefaultExtension("/abs/path/to/creds.ts");
registerSubagentDefaultSkill("/abs/path/to/SKILL.md");
```

`runReviewer` (and therefore `runSubagent` / `runFleet`)
prepends the registered paths onto the per-call
`extraExtensions` / `extraSkills` arrays before composing
argv. Duplicates are coalesced. The defaults survive an
`isolated: true` job because pi honours `--extension` /
`--skill` injections even after `--no-extensions` /
`--no-skills`.

The registry is process-global because pi loads every
extension into one Node process. Pi extensions can also
listen for the `subagent-workflow:ready:v1` event and
register via the `SubagentWorkflowApi` object the event
carries — see the `subagent-workflow` extension.

## Verify packs

When a job carries a `verify: VerifyPack`, the engine
injects the pack's extension (`--extension`) and skill
(`--skill`) into the subagent and enforces that
`verify_output` was called and returned `ok: true` before
accepting the run. Schemas live in the pack; the engine
treats them opaquely.

`verifyProtocolInstruction()` returns the canonical prose
explaining the call/retry/end protocol when a caller wants
to drop it into a prompt without authoring its own
companion skill.

## Files

- `subagent.ts` — top-level entry: `runSubagent`,
  `runFleet`, `runReviewer` (legacy), arg composition,
  result extraction and verify enforcement.
- `stream.ts` — JSON-stream parser: collects the final
  assistant turn, watches `verify_output` tool calls,
  enforces line and warning caps.
- `artifacts.ts` — durable on-disk state for supervised
  runs (events, progress, lease, result).
- `recovery.ts` — replay on-disk artifacts back into
  `RecoverySummary`/`RecoveredReviewerProgress` records for
  the parent to surface in-flight work.
- `runpi/spawn.ts` — fire-and-forget runner. Cheapest path.
- `runpi/supervisor.ts` — durable runner. Each call writes
  a request file, spawns `supervisor.mjs` detached and
  streams events back via the artifacts store.
- `runpi/supervisor.mjs` — the supervisor process itself.
  Stays as `.mjs` because pi spawns it directly without
  TypeScript on the path.
