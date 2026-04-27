# Guardian Status Workflow

Registers a `/guardian-status` command that shows the
last-call outcome of every registered guardian. Read-only:
opens a scrollable panel and dismisses on Esc.

## Why It Exists

When a long-running session reports that gates have silently
stopped firing, there's no way to confirm whether each
guardian actually ran for the most recent bash command.
`/guardian-status` answers that question: it lists every
guardian that has registered and shows what each one decided
on its most recent invocation.

Outcomes:

- `allowed` — review returned ALLOW.
- `blocked: <reason>` — review returned a block.
- `rewritten` — review returned a rewrite.
- `skipped (<why>)` — short-circuited before review:
  - `no-ui`: no terminal session attached.
  - `bypassed`: bypass toggle is enabled (see `/git-intercept`).
  - `detect-miss`: command didn't match this guardian's
    pattern. Most common; tells you the guardian is running
    but the last bash command wasn't the kind it gates.
  - `parse-null`: detector matched but parsing returned null.
    Usually a parsing bug worth investigating.

`never called` means the guardian registered but no `tool_call`
event has reached it yet — typical right after `/reload`.

## How It Works

Reads from the registry populated by `registerGuardian` in
`lib/guardian/register.ts`. The registry is keyed by
`Symbol.for("pi:guardian-registry")` on `globalThis`, so a
single registry is shared across independently-loaded
extension packages: guardians from `agentic-harness.pi` and
from any downstream package that opts in (by passing `name`
to `registerGuardian`) appear in the same panel.

State is per-process: lost on `/reload` or restart, which
matches the diagnostic intent.
