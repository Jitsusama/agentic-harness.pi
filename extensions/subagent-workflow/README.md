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
