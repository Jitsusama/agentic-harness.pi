# observability-workflow

Records first-class run telemetry for subagent and council
fan-outs, so you can answer how a run did and what it cost
from real data rather than by re-parsing CLI args.

## What it does

- Registers a recorder sink that the fleet dispatcher and
  the council runner emit into as each subagent finishes.
  The parent session is the single writer.
- Persists one row per subagent (model, persona, verify
  outcome, retries, warnings, token tiers, proxy-reported
  cost, start time) into a SQLite table in this extension's
  own state directory, kept separate from the memory store.
- Surfaces a compact session figure on the status line
  (recorded run count and session cost).
- Exposes the `observe_runs` tool. Pass a `runId` to
  summarize one run; omit it for a recent-runs digest plus
  the weekly per-model and per-persona trend rollups. No
  slash command; the agent calls the tool when asked.
- Rolls rows older than the 30-day retention window into
  weekly summaries lazily at session start, so long-term
  trends survive while per-run detail ages out.

## Design

The queryable core lives in `lib/observability` (the store,
the record mapper and the rollup logic) and is unit-tested
through its public API. This extension is thin wiring: it
opens the store, registers the recorder, contributes the
status line, registers the tool, and runs lazy retention.

Cost accounting depends on the subagent usage-accumulation
fix: each `message_end` carries one request's usage, summed
across the run, so the recorded cost is the true total.
