# Install Check Workflow

Says when the code pi is running is not the code on disk, or not
the code the install was meant to hold.

## Why It Exists

Two kinds of drift fail silently in a package installed by path or
from git:

- **A pull is not a reinstall.** After a fast-forward, the code can
  import a dependency's new export while `node_modules` still holds
  the version before it. Nothing fails at load; the import reads
  `undefined` and the first call throws somewhere far from the cause.
  This broke the cost tool once with `openLedgerReader is not a
  function`, while core 0.6.15 sat where `^0.6.18` was asked for.
- **A pull is not a reload.** pi evaluates an extension when it loads,
  so a merged fix sits on disk while the session runs the version
  before it. A month of compaction improvements reached 2 live
  compactions in 957 this way.

## What It Says

- **At session start:**
  - any dependency whose installed version falls outside its range
    in `package.json`, or that is missing, with the install command
    to run (`pnpm install` beside a pnpm lockfile, otherwise
    `npm install --omit=dev`) and a reminder to `/reload`;
  - how many commits the checkout is behind its upstream, as of the
    last fetch. A fetch from any worktree updates the shared refs, so
    this catches a live checkout left behind its siblings.
- **After a run ends, at most every ten minutes:** whether the
  checkout's HEAD moved since this code loaded, once for each new
  HEAD, and the dependency check again, since a pull moves both.

Each notice is said once a process, and only in a session with a UI.

## How It Works

The range check is pure and lives in `lib/internal/install/drift.ts`.
It reads the shapes this package writes (caret, tilde, exact, `>=`
and `*`) over full `major.minor.patch` versions. Anything else, such
as a git spec, a partial version or a prerelease, is unchecked rather
than guessed at, so it never asks for a reinstall it cannot justify.
Installed versions are found the way Node resolves them, walking up
`node_modules` from the package.

The HEAD baseline is taken when the extension loads, not at session
start: a new session runs the code this process loaded, and a reload
evaluates the extension again and takes a fresh one. Git calls time
out after two seconds and never hold up a session. Without a `.git`
in the package, as on an npm install, only the dependency check runs.
