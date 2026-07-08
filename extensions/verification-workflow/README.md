# verification-workflow

Closes the trust gap after an edit: it runs the right check
at the right moment so the agent can confirm its own work
still builds, without grinding an autonomous run to a halt.

## What it does

- Tracks the files pi changed during a turn from the edit and
  write tool results.
- Fast layer, at the turn boundary: when the agent is about to
  yield, it asks the resident LSP backend for diagnostics on
  the files touched this run. New error-severity problems are
  enqueued as a follow-up through `pi.sendUserMessage(...,
  { deliverAs: "followUp" })`, which the agent loop drains just
  after the turn ends and before it stops, so the agent
  continues and self-corrects before handing the turn to the
  user. It runs in milliseconds against a warm server and skips
  entirely when no server resolves.
- Medium layer, on request: the no-command verify tool runs
  the project's resolved check command and reports whether
  the code still builds and passes. The agent calls it when
  asked whether something works, still builds, or is green.
- Surfaces the last outcome on the status line.

## Restraint

Nothing runs after every edit. The fast layer fires once at
the turn boundary; the medium layer only when asked. The loop
defers entirely while a TDD loop is active, since that already
governs verification for the code under test, and caps its fix
requests so a run that cannot reach green hands back to the
user rather than thrashing.

## Check-command resolution

The verify command is resolved by precedence: a quest's
verify field, then a package.json verify script, then
detection of the conventional lint, typecheck and test
scripts, run with the project's package manager. The quest
field is fed from the loaded quest: quest-workflow mirrors the
quest frontmatter's `verify` onto its session entry, and this
workflow reads it from there, so a quest can name the exact
check that proves its work (a subdirectory or a single zone)
rather than the whole repo's.

## Commit gate

When a fast-layer pass finds errors, this workflow publishes a
failing signal (a process-global mirror of its outcome). The
commit guardian reads that signal and refuses a commit while
checks are red, so the block lives in the single sanctioned
commit-review site rather than a competing interceptor here.
The guardian is skipped when git interception is bypassed, so
the bypass toggle is the escape hatch when the block is wrong
or stale.
