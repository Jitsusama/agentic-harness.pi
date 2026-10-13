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
- Medium layer, on request: the verify tool runs the project's
  resolved check command and reports whether the code still
  builds and passes. The agent calls it when asked whether
  something works, still builds, or is green. It runs in the
  project holding the file edited most recently, or the one its
  `path` names, and says which directory it checked. The
  session's directory is only the last resort: a worktree sits
  elsewhere, and the checkout it was cut from may have nothing
  installed. A check that could not start (a command not found,
  or no check command at all) reads as deferred, since it says
  nothing about the code.
  The command runs detached in its own session with no
  controlling terminal and with plain, non-interactive output
  forced, so a noisy test runner cannot write over the TUI
  while it runs; its captured output is stripped of ANSI and a
  passing run returns only its summary.
- Surfaces the last outcome on the status line.

## Restraint

Nothing runs after every edit. The fast layer fires once at
the turn boundary; the medium layer only when asked. The loop
caps its fix requests so a run that cannot reach green hands
back to the user rather than thrashing.

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

This workflow offers a check, process-global, that the commit
guardian calls when a commit arrives, so the block lives in the
single sanctioned commit-review site rather than a competing
interceptor here. The answer is worked out when it is asked,
never read from an earlier pass:

- The files that last had errors are diagnosed again, and only
  those in the repository the commit lands in, worked out from
  its `cd` segments and `git -C`. A file the server does not
  reach within ten seconds is not held against the commit.
- A failed verify run counts while its tree is the one it
  judged: the same HEAD, and the same size and modification
  time on every changed file. Staging moves no file, so it does
  not count as a change. Outside git, an edit under its project
  retires it instead.

It used to publish a flag that only the end of a turn refreshed,
and a verify run in the wrong directory could set it, so a commit
was refused for errors fixed minutes before. The refusal now
names each problem it confirmed. It is the `commit-verification`
guard, which blocks by default; `/guards commit-verification
report` lets commits through and records what it would have said.
