# Subagent Workflow

One tool, one progress panel, one supervisor. Run N pi
subagents concurrently for persona sweeps, multi-angle
investigation, or fleet brainstorming.

The agent calls a single `subagent` tool with an array of
job definitions; the extension fans them out, surfaces
live progress in a focused prompt-area panel, and returns
each subagent's final assistant text plus aggregate token
and cost figures.

## Tool: `subagent`

```ts
subagent({
  jobs: [
    {
      id: "security",
      model: "anthropic/claude-haiku-4-7",
      thinkingLevel: "high",
      cwd: "/path/to/repo",
      systemPrompt: "You are a security reviewer …",
      userPrompt: "Audit src/auth for missing checks.",
    },
    {
      id: "performance",
      model: "anthropic/claude-haiku-4-7",
      cwd: "/path/to/repo",
      systemPrompt: "You are a performance reviewer …",
      userPrompt: "Walk src/auth for hot-path allocations.",
    },
    // …
  ],
})
```

Every `SubagentJob` field flows through: `systemPrompt`
becomes pi's `--system-prompt`, `skills` and
`extraExtensions` become `--skill` / `--extension`,
`isolated` toggles the three `--no-*` flags as a unit, and
`verify` injects a verify pack so the subagent must call
`verify_output` before ending.

The tool returns:

```ts
{
  runId: string,
  results: Array<{
    id: string,
    finalAssistantText: string,
    warnings: string[],
    state: "complete" | "cancelled" | "failed",
    error?: string,
    usage?: SubagentUsage,
  }>,
  totalUsage?: SubagentUsage,
  warnings: string[],
}
```

The host agent reads `results[*].finalAssistantText` to
synthesize, compare, or hand the outputs back to the
user. `totalUsage` lets it confirm spend.

## Defaults

- **`isolated` defaults to `true`** at this extension's
  tool boundary, even though the library default is
  `false`. The fleet use case is "give me a clean slate"
  far more often than not; pr-workflow's reviewers
  inherit the user's ambient setup and own that
  decision themselves. The skill teaches when to flip
  the default back.
- **No worktree provisioning.** Callers pass `cwd`
  directly. Use the project root for ad-hoc work, or set
  up a git worktree yourself when you need detachment.
- **No `runId` required.** The extension generates one
  when omitted so durable supervisor artifacts always
  have somewhere to land.
- **Per-job timeout overrides.** The supervisor enforces
  a 20-minute wall-clock cap and a 5-minute idle ceiling
  by default. Jobs that issue long-running bash commands
  with no intermediate output (benchmarks, deploys,
  pushes against large mirrors) override either or both
  via the optional `timeoutMs` and `idleTimeoutMs` fields,
  both in milliseconds. Overrides are per-job; short-
  lived siblings keep the tight defaults. The skill
  covers when to reach for them.

## Default extensions and skills

Other pi extensions can register paths that should be
loaded into *every* subagent in the session, regardless
of per-job `isolated` settings or `extraExtensions`
values. Use this for credentials helpers, telemetry
hooks, or org-wide setup that every subagent needs.

Two events make this work, mirroring the bidirectional
`pr-workflow:ready:v1` handshake used elsewhere in the
package. Listening to *both* is the load-order-safe
pattern: it covers extensions that activate before this
one AND extensions that activate after.

```ts
import type { SubagentWorkflowApi } from "./index.js";

const EXTENSION_PATH = "/abs/path/to/creds.ts";

// (1) If we activated AFTER subagent-workflow, the ready
// event already fired. Emit the register event directly
// — subagent-workflow's listener is still subscribed.
pi.events.emit(
  "subagent-workflow:register-default-extension:v1",
  EXTENSION_PATH,
);

// (2) If we activated BEFORE subagent-workflow, the
// emit above hit nothing. Listen for ready and call the
// API method then.
pi.events.on(
  "subagent-workflow:ready:v1",
  (api: SubagentWorkflowApi) => {
    api.registerDefaultExtension(EXTENSION_PATH);
  },
);
```

The registry dedupes by path so doing both is safe —
the path lands once regardless of which event delivers
it. Same shape exists for skills:
`subagent-workflow:register-default-skill:v1` carries an
absolute `SKILL.md` path.

Direct imports from `agentic-harness.pi/subagent`
(`registerSubagentDefaultExtension`,
`registerSubagentDefaultSkill`) are also supported for
package-internal callers and tests.

Registered paths reach the subagent via pi's
`--extension` / `--skill` flags, which are honoured even
under `isolated: true` (i.e. alongside `--no-extensions`).
That's the point of the hook — a clean-slate subagent
that still has the bits it absolutely needs.

## Progress panel

When pi has a TUI, the tool installs a focused panel
into the prompt area while the fleet runs:

```
─────────────────────────────────────────────────────────
 Subagent Fleet
 ↑/↓ select · r cancel selected subagent · Esc cancel fleet

 ▸ ◈ running   security  · claude-haiku · last: reading auth.go
   ◇ pending   performance · claude-haiku · queued
   ✓ complete  readability · claude-haiku · 12,403 tokens
─────────────────────────────────────────────────────────
```

The status line shows a one-glance summary
(`fleet 2/3 done running=1`). Headless sessions skip the
panel and just return results.

## Files

- `index.ts` — registration only: declares the tool,
  wires the supervisor, the cancellation registry and
  the progress reporter.
- `run.ts` — orchestrator: takes assignments, dispatches
  via the library's `runSubagent`, threads progress and
  cancellation, aggregates usage.
- `progress.ts` — observer interface plus the stream-
  activity summarizer.
- `progress-render.ts` — production status-line +
  focused-panel reporter.
- `cancellation.ts` — fleet-shaped cancellation
  registry (copied from pr-workflow's review-shaped one;
  see plan PR 6 for why they're separate).

The library at `lib/subagent/` is the substrate. The
`subagent-fleet-guide` skill is the methodology — read it
when you're deciding whether to reach for this tool.
