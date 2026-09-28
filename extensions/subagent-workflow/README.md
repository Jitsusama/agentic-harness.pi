# Subagent Workflow

One tool, one progress panel, one supervisor. Run N pi
subagents concurrently for persona sweeps, multi-angle
investigation, or fleet brainstorming.

The agent calls a single `subagent` tool with an array of
job definitions; the extension fans them out, surfaces
live progress on a board above the editor, and returns
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
      systemPrompt: "You are a security reviewer ...",
      userPrompt: "Audit src/auth for missing checks.",
    },
    {
      id: "performance",
      model: "anthropic/claude-haiku-4-7",
      cwd: "/path/to/repo",
      systemPrompt: "You are a performance reviewer ...",
      userPrompt: "Walk src/auth for hot-path allocations.",
    },
    // ...
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
  runDir?: string,
  results: Array<{
    id: string,
    finalAssistantText: string,
    resultPath?: string,
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

Each run is durable on disk. `runDir` is the run's root
and each result's `resultPath` points at that subagent's
`result.json`; the text summary prints both. Read a
subagent's full output back with the plain `read` tool
when the summary truncated a long `finalAssistantText`,
without re-running the fleet. Both fields are present
only when the run directory resolved (it always does in
normal operation); older callers that ignore them keep
working.

## Defaults

- **`isolated` defaults to `true`** at this extension's
  tool boundary, even though the library default is
  `false`. The fleet use case is "give me a clean slate"
  far more often than not, whereas a review round's
  participants inherit the user's ambient setup and own
  that decision themselves. The skill teaches when to
  flip the default back.
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
`review:ready:v1` handshake used elsewhere in the
package. Listening to *both* is the load-order-safe
pattern: it covers extensions that activate before this
one AND extensions that activate after.

```ts
import type { SubagentWorkflowApi } from "./index.js";

const EXTENSION_PATH = "/abs/path/to/creds.ts";

// (1) If we activated AFTER subagent-workflow, the ready
// event already fired. Emit the register event directly
// subagent-workflow's listener is still subscribed.
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

The registry dedupes by path so doing both is safe;
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
That's the point of the hook: a clean-slate subagent
that still has the bits it absolutely needs.

## Progress Board

When pi has a TUI, the tool docks a board above the editor
while the fleet runs. The editor keeps focus, so a steer or
the next question can be typed meanwhile:

```
── Subagent Fleet · 1/3 done ────────── Ctrl+Alt+N to manage ──
  → running security · claude-haiku · last: reading auth.go
  ◦ pending performance · claude-haiku · queued
  ✓ complete readability · claude-haiku · 12,403 tokens
```

Escape in the editor is pi's: it stops the turn, and the
turn's signal stops the fleet. `Ctrl+Alt+N` (registered by
`panel-lifecycle-workflow`) moves the keys to the board,
which then shows a cursor and a keys row: up and down
select, `r` cancels the selected subagent, Escape cancels
the fleet and gives the editor back while the turn goes
on, and the same chord moves on without cancelling
anything: to the next widget docked, if there is one, else
back to the editor. With a gate or another fleet up, the
board's footer counts the presses it is away ("Ctrl+Alt+N
twice to manage"). Ctrl+C and Ctrl+D always reach pi.

The board shrinks to fit the rows pi can give it without
redrawing the transcript, keeping the title and the
selected row. It leaves as the tool returns, in the frame
the result card arrives: the card opens with the same rows
and adds where the full output lives, so it is never
shorter than the board it replaces.

The status line shows a one-glance summary
(`fleet 2/3 done running=1`), keyed per run so two fleets
do not overwrite each other. Headless sessions skip the
board and just return results.

## Files

- `index.ts`: registration, plus the session-start
  housekeeping. Declares the tool, wires the supervisor,
  the cancellation registry and the progress reporter,
  and holds `sweepFleetRuns`, which is its own function
  rather than a handler body because it is four policies
  in a row.

- `run.ts`: orchestrator. Takes assignments, dispatches
  via the library's `runSubagent`, threads progress and
  cancellation, aggregates usage.
- `progress.ts`: observer interface plus the stream-
  activity summarizer.
- `progress-render.ts`: production status line, docked
  board and result card.
- `cancellation.ts`: fleet-shaped cancellation
  registry. A review-shaped sibling once lived beside it;
  the review substrate now derives each participant's
  signal from the one pi hands a tool's execute.

## What Is Kept, and What Reclaims It

A fleet's answers exist in two places: the tool result
handed back to the session that asked, and the
transcripts on disk. A session that dies mid-fleet never
produces the first, so the second is the only copy of
work that has been paid for.

So a fleet is written down before it is dispatched, in a
ledger under `fleets/` beside the run directories, and
released when it is handed back. An unreleased fleet is
protected absolutely: no window takes it, because what
protection asserts is that this run holds the only copy
of something, and a clock does not make that untrue.

Cancellation counts as unreleased, both kinds. The
signal is pi tearing the call away; the board is somebody
pressing a key, which is the only cancellation this
extension documents to anybody, and it leaves the signal
untouched and hands back a result with cancelled entries
in it. Either way an answer did not arrive, and what
that subagent wrote is on disk and nowhere else.

That leaves one population that grows without a bound,
and two things follow from it. The sweep says how many
such fleets it held once there are enough to matter, and
names both the directory holding the transcripts and the
file to delete to let one go. It says it only of the ones
nobody is waiting for, which is why a record carries the
pid and birthday of the session that dispatched it: a
fleet another session is running right now is held too,
and the only lever the message offers would unprotect
work still being paid for. Deleting that file is the
only release there is, and it is deliberate rather than
automatic: nothing can tell whether somebody has read a
transcript.

The ledger has a window of its own, over settled records
older than the longest window their transcripts get, or
it becomes the unbounded thing it was built to bound. It
reclaims abandoned staging files on the same pass, and
only ones an hour old, since the gap between a write and
its rename is microseconds and a fresh one is somebody's.

A ledger file that will not read stops the sweep, on this
machine, until somebody deals with it. An empty protect
set is not the cautious reading of a torn ledger: it is
the one that deletes everything the ledger was keeping.

Orphans are the other half, and they are narrower than
they look. A fleet job is always one somebody is waiting
for, so its request carries the waiting session's pid and
the supervisor stops its child within half a second of
that pid going. A session dying mid-fleet therefore
leaves nothing running, which is asserted against the
real supervisor script rather than assumed. What it does
leave is transcripts, and that is what the ledger is for.

The one orphan a fleet can have is a child whose
supervisor was itself killed. That child was spawned into
its own process group, so it outlives the supervisor,
holding a model against a wall clock nothing is watching,
and its pid was known only to the process that died. Each
session start asks the same recovery the review side uses
to stop those, and says which ones it stopped.

One gap is known and open. A record for a fleet that
never wrote a transcript is protected like any other and
is never mentioned, since the count reports what the
sweep held and there is nothing on disk to hold. Those
are small and rare, but they are the one population no
window reaches.

The library at `lib/subagent/` is the substrate. The
`subagent-fleet-guide` skill is the methodology. Read it
when you're deciding whether to reach for this tool.
