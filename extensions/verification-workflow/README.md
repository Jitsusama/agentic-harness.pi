# verification-workflow

Closes the trust gap after an edit: it runs the right check
at the right moment so the agent can confirm its own work
still builds, without grinding an autonomous run to a halt.

## What it does

- Tracks the files pi changed during a turn from the edit and
  write tool results.
- Fast layer, once per turn: when the agent yields, it asks
  the resident LSP backend for diagnostics on only the
  touched files. New error-severity problems are injected
  back as a follow-up so the agent fixes them before handing
  the turn to the user. It runs in milliseconds against a
  warm server and skips entirely when no server resolves.
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
field is wired through the resolver but not yet fed, pending a
small change in quest-workflow to expose the loaded quest's
directory to session state; project config and detection work
today.

## Not yet wired

The commit-gate block (refuse a commit while checks are red,
respecting the git-bypass toggle) is deliberately left out:
commit-guardian is the single sanctioned commit-review site,
so blocking there belongs to a change in that guardian rather
than a competing interceptor here.
