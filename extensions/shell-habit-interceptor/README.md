# Shell Habit Interceptor

Catches four shell habits the harness's standing rules forbid, as the
command runs, since saying the rules in the prompt did not stop them.
On the first day of 2026-W44, 14 of 17 active sessions cut build or
test output with tail or head, 13 waited with sleep, and 5 ran
`git stash`.

- **A trailing `| tail -N` or `| head -N`** on a build or a test run
  (vitest, cargo, pnpm, nix build, changed-checks and the like) is
  dropped without a word. Pi keeps the end of what a command prints and
  saves the rest to a file, so the pipe only held the output back until
  the command ended, and hid the command's own exit status.
- **`stash`** refuses `git stash` saving work, pointing at a branch and
  `work record`, or a copy in `$TMPDIR`. Reading or restoring a stash
  (`list`, `show`, `pop`, `apply`) goes ahead.
- **`sleep`** refuses a sleep of ten seconds or more, pointing at
  `background: true`. A short sleep between polls goes ahead.
- **`shell-edit`** refuses a redirect, `tee`, `sed -i` or `perl -i`
  onto a file git tracks, pointing at the edit and write tools. A shell
  rewrite skips the edit path and leaves the language server answering
  from a stale copy; the learning sensor saw it in 45 sessions in the
  week to 2026-10-26. Each target is placed where the command's own
  `cd` puts it, and a new file, scratch or `/dev/null` goes ahead.
- **`mixed-turn`** refuses one call that runs VM work beside other
  heavy work, such as `changed-checks --no-vm` and then `run-subtests`,
  and prints the split: each step its own call, the VM work last. The
  machine queue gives a call one turn, as its heaviest step, for its
  whole length, so the build held a VM slot the whole time: 32 of 41
  VM-test jobs did on the night of 2026-10-28, 9.6 of 10.6 slot hours.
  One build naming VM checks among others is one step, and goes ahead.

Each guard redirects: the agent hears what to do instead, and sending
the same command again goes ahead. Each reads the command with heredoc
bodies and quoted text stripped, so a script or a message that only
mentions one of these is left alone. The detectors are in
[`lib/internal/shell-habits.ts`](../../lib/internal/shell-habits.ts).
