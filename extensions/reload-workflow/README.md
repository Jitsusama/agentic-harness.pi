# Reload Workflow

Lets the agent reload its own session, onto the worktree it is
changing when it wants to, and carry on once the reload lands.

## Why It Exists

Trying a change to the harness used to mean merging it, waiting for a
person to reload, hearing back, and going round again. The session
logs hold about 330 "reloaded" turns. Gates fired before the person
could reload, the agent did not know a reload had happened, and a
change nobody had merged could not be tried at all, since a reload
loads the install and the install is `main`.

## What It Does

- **The `reload` tool.** The agent asks for a reload with a reason
  and, optionally, what to load: a checkout of this package, or
  `installed`. Left out, the session reloads whatever it runs now, so
  a tree being edited stays a tree.
  - A tree is loaded first in a pi of its own (see
    [Load Check](#load-check)), and a tree that does not load is
    refused with what failed, before anything is touched.
  - The reload waits for the run to end, then runs. When it lands, a
    turn says what was asked, which code now runs, from where and at
    which commit, and the agent carries on. Away mode keeps going
    through it.
- **Every reload says what loaded.** pi's own `/reload` leaves the
  model a hidden note saying which code now runs, so the agent knows
  the code changed under it. Nothing is shown to the person, who did
  the reload.
- **Following the install.** A session that runs the install of a
  package its settings name reloads itself when that install's HEAD
  moves, so nobody has to mail every session to reload.
  - It waits for a moment that loses nothing: an idle session at
    its place in a ten-minute spread, a busy one when its run ends,
    and either only once
    `pnpm install` has followed a move that changed the lockfile.
    A pi-packages version is built whole in a folder of its own
    before its `current` link moves, so a root that is a link is
    ready as soon as its own install is newer than its lockfile; on
    29 October sessions had waited five minutes for an install
    that had already finished.
    An idle session's place is a share of the spread its session id
    fixes: on 6 November at 05:30 the 77 sessions that heard a move
    reloaded within about 2 minutes, idle ones too, and load average
    reached 127. A run ending reloads at once, since runs end at
    their own times.
    Background work is no reason to wait: it keeps running
    through a reload, and their results arrive in the reloaded
    session (see [job-workflow](../job-workflow/#through-a-reload)).
  - It does not wait for the cache: pi sends tool and section
    changes without rewriting it, now that no hook forces the system
    prompt (agentic-harness.pi#641).
  - Every reload, whoever asked, waits until the session has been
    idle for a second with nothing queued, since a run a compaction
    cut short is resumed just after it ends.
  - In a busy session the harness's own deliveries filled every
    such second: on 29 October a reload waited 35 minutes while
    background results and mesh notes started each next run. So
    while a reload waits, a background result waits up to ten
    seconds after a run ends, and a mesh note is said without the
    turn it would start, which the landing starts instead, or mesh
    itself ten seconds on (`lib/internal/reload/hold.ts`). A
    compaction's resume is never held, since nothing would say it
    again.
  - Afterwards one line in the model's context, not shown, says it
    reloaded and everything that came in by then: a merged pull
    request by its number and title, anything else by its subject.
    The person sees which code runs in the status bar; shown, one
    notice per install filled idle sessions with eight in an hour.
    It starts a turn only when a delivery put its turn off for the
    reload.
  - A session running a tree is never moved, and only a session
    somebody sits at follows: not a subagent, nor a print-mode run.
    `PI_FOLLOW_INSTALL=off` turns it off.
  - One `fs.watch` per install's git directory, read once the
    checkout has been still for three seconds. An install named by a
    link is also read every 30 seconds and at every settle: a watch
    can be lost without a word, and on 29 October nine sessions stayed
    five installs behind for five hours.
  - Its own reload, handed to the command and waiting ten minutes with
    none under way, is asked again. The first time, a `reload-held`
    entry in the session's log says what held it.
  - A session that heard its install move but holds back says why
    once, in a `reload-waiting` entry: it runs another install, another
    reload is waiting, or its context has gone. An install the start
    couldn't read, as when thirty sessions start at once, is read
    again rather than taken for a tree: on 30 October three idle
    sessions stayed six hours on the code the restore loaded.
- **MCP servers kept across a reload.** pi drops what an extension
  registered as it loaded, so on 30 October every reloaded session
  lost the tool gateway. The servers pi lists as a reload begins are
  registered again once it lands, where the reload lost them, and pi
  connects them at once. One the reload kept is left alone. In a
  host each conversation keeps its own, so another starting or
  reloading meanwhile neither clears nor takes them.
- **Work left for a replaced session never ends pi.** A reload,
  rollover or switch makes the old context throw pi's stale error on
  every read, and work still on its way that reads it rejects. When
  nothing watches it, Node raises an uncaught exception and pi exits:
  on 7 November one footer item ended sessions that way dozens of
  times. One handler per process drops exactly that rejection and
  writes it with its stack to `stale-rejections.jsonl` in this
  extension's state folder, so each is found and fixed where it
  happens. Any other rejection is thrown again, and pi crashes on it
  as before. In a host the process is the host's, so its entry
  installs the net once and no conversation's load adds it.
- **`⇄` on the footer** while the session runs code other than the
  install pi's settings name, muted, and only then.
- **`/harness`** says what runs, from where, at which commit, and
  where the install is. `/harness reload` reloads onto it again: pi's
  own `/reload` goes back to the install.

## How It Works

pi gives `reload()` only to a command's context, never to a tool's,
and reloading under a streaming run would pull its tools away. So the
tool only records the request. On `agent_settled` it is handed to
`/harness reload` through `pi.sendUserMessage` with
`expandPromptTemplates`, pi's own way to dispatch a command, which
runs it with a full command context once the settle is over.

pi tells packages apart by where they come from, so a tree added
beside the install would load as a second copy, every tool registered
twice. The command instead points the install's own entry in the
personal settings at the tree, reloads (pi re-reads its settings on a
reload), and puts the entry back in a `finally`, whether the new code
came up or not. Settings name the tree only for the seconds the
reload reads them, so other sessions, and this one's next `/reload`,
keep the install. Both writes go through pi's `SettingsManager`,
which locks the file and writes only the fields it changed.

What survives the reload is a slot on `globalThis` under a
`Symbol.for` key (`lib/internal/reload/slot.ts`). The old runtime
leaves its request there; the new one leaves the function that says
the reload landed; the old command calls it once `reload()` returns.
A runtime started any other way drops a request left there, so pi's
own `/reload` cannot set off a second one.

A reload and a rollover never overlap. pi's `reload()` loads for
seconds before it starts the new runtime, and on 2026-11-03 one begun
as a rollover switched finished on the log left behind: a live
runtime on the old log, its follower on older code, reloading the
live session every 30 seconds. The rollover now marks the slot
(`rolling`) while it switches and declines while a reload is asked
for or under way; the follower waits out the mark, and the command
does nothing under it, saying so. A session the process rolled away
from (`lib/internal/session/left.ts`) that starts again follows
nothing, since its start would stop the live session's follower.

A landing the agent asked for is said through the job host, the only
thing that starts a turn nobody typed. One the person asked for is a
hidden custom message.

## In a Host

The request slot, the follower and `loaded/<pid>` are one per process,
and a tree is swapped in through pi's shared settings. In a
multi-session host each would act for every conversation at once, so
a hosted conversation uses none of them: it follows no install, and
it asks its host to reload it instead (`hosted.ts`). The `reload`
tool queues the request in the conversation's own slot; the end of
that conversation's run hands it to the host's `reload`, which reloads
that conversation alone and keeps its slots; and its new runtime says
the landing, as on plain pi. `/harness reload` asks the host at once,
and takes any request the agent left waiting with it. A tree is
refused, since every conversation loads the harness from the install
the host runs, and a host that can't reload a conversation has both
refuse, saying why. A reload reads that install from disk again, so
once pi-packages moves it a reloaded conversation runs the new
version while the others keep the old one until each reloads: an
install swap reaches a host one conversation at a time. Each
conversation's load still writes
`loaded/<pid>`, so pi-packages keeps the version the host runs, but
none takes it back and no exit listener is added: one conversation
ending must not take it back for the others, and pi-packages removes
a file once its pid has ended.

## Load Check

`lib/internal/reload/load-check.ts` starts pi in RPC mode with
nothing but the package (`--no-extensions`, then `-e <root>`), asks
for its commands, which needs no model, and closes stdin. pi exits 1
naming every extension that failed to load. The whole package takes
about 13 seconds.

`pnpm load-check` runs the same check the way a person who installs
the package would: it copies the files git would hand pi, installs
them with pi's own command for a git package (production dependencies
only, peers not auto-installed), and loads the copy. CI runs it as
the `Load (pi)` job, so a runtime dependency in the wrong list fails
a pull request rather than a laptop. `node scripts/load-check.ts`
without `--production` loads the checkout as it stands.
