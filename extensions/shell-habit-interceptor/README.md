# Shell Habit Interceptor

Catches three shell habits the harness's standing rules forbid, as the
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

Both guards redirect: the agent hears what to do instead, and sending
the same command again goes ahead. Each reads the command with heredoc
bodies and quoted text stripped, so a script or a message that only
mentions one of these is left alone. The detectors are in
[`lib/internal/shell-habits.ts`](../../lib/internal/shell-habits.ts).
