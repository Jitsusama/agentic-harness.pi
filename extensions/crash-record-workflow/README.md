# Crash Record Workflow

What the system's log hears of a pi: how long it took to be ready,
why it ended when an uncaught error ends it, in its session's log
too, as a `crash` entry, with the stack, and what held it when it is
slow to end.

## Why It Exists

On 11 November about 40 pis died within 13 minutes of one another,
and nothing said why in either the session logs or the journal. pi's
own handler had printed each error to its terminal, which closed
with the window when the session was started again elsewhere, and
added it to `~/.pi/agent/crashes.json`, which nothing reads. The
cause, an unhandled write refusal, was found only by thinking to open
that file.

Health holds pi to starting in 3 seconds, and on 12 November the 42
pis started since midnight had taken a median of about 5, with some
over 30. Nothing in the journal said how long any one took, so each
figure had to be pieced together from session logs.

At the reboot of 14 November, 8 of the 10 held pis were still ending
when systemd's 5 seconds ran out and were killed, and nothing said
what they were waiting on. An idle pi alone ends in under half a
second, so the wait was on something only a real session reaches.

## What It Does

- Writes `pi: ready in N ms, session <id>` to the system's log at
  info, once, when the process's first session has started and its
  history is drawn, timed from the process's start. A reload, a new
  session or a resume isn't timed, nor a pi with no screen, such as a
  subagent. The write doesn't wait.
- Says, after the session, what a slow start spent its time on as far
  as an extension can see: `log B bytes`, the size of the log pi read
  whole before loading any extension; `loaded by L ms`, when this
  extension loaded, part way through the rest; and `bound by T ms`,
  when the session started with every extension bound. pi times the
  log's read itself only under `PI_TIMING`, so that stays inside
  `loaded by`.
- Writes each uncaught throw, and each rejection nothing handled, to
  the session's log as a `crash` entry before pi's handler exits.
- Writes the same error, naming the session and its folder, to the
  journal through `systemd-cat` on Linux, or the unified log through
  `logger` on macOS, each taken only from the system's own folders.
  The write waits at most 2 seconds.
- Changes nothing about how the process ends: Node's
  `uncaughtExceptionMonitor` runs before pi's own handler, which
  still prints, records and exits.
- Says what holds a pi still ending 2 seconds after a TERM or a HUP,
  or after its session quit: `pi: still ending N ms after SIGTERM`,
  naming what the process still holds open and the processes under
  it, at err, with a fuller record (libuv's handles and the resource
  use, never the environment) in
  `~/.local/state/pi/agentic-harness.pi/crash-record-workflow/slow-ends/`,
  which keeps the newest 100. Its timer never keeps the process up,
  and the line waits on nothing. Once armed it listens for no signal,
  since a listener left behind would keep a later TERM from ending a
  pi whose own handlers are gone. An extension can't name which
  shutdown handler is still running; what stays open and the
  children are the evidence. See `lib/internal/session/slow-end.ts`.
- Ends a pi whose exit would wait on a name lookup. Node's exit waits
  for libuv's threadpool, a lookup there can't be cancelled, and with
  the network gone each waits 10 seconds for the resolver to give up,
  past any timer. So once the watch arms, a last exit listener that
  finds one writes the record and a `pi: still ending` line with
  `held: exit waits on a name lookup`, waiting for both, and ends the
  pi by its own TERM. Such a pi leaves with status 143, not 0: Node
  has no way to exit with a code that skips the threadpool. A quit
  nobody asked ends by USR2 instead, which its holder restarts.
- Says who asked a pi to quit: `pi: quitting session S, asked by X`
  in the system's log. The session's log gets nothing, so a hosted
  conversation's record keeps plain pi's shape. The
  asker is whatever named itself just before (a mesh close, the quest
  ending, a park, a restart onto fresh code, one-writer), the
  person's exit key, second clear key or `/quit` as they bound them,
  or the TERM or HUP the watch heard first. An ask lasts 30 seconds,
  and a key that is no quit takes a key's ask back.
- Restarts a held pi that quits at nobody's ask: it exits 79 rather
  than 0, which its holder answers by starting it again. A code
  something else set, as a park's 75 or one-writer's 78, stands, and a
  pi no holder runs ends as it would have.
- Arms only in plain pi. A host runs many conversations in one
  process and installs what that process listens for itself.

The process keeps one listener, which each load replaces with its
own, so a reload never leaves an older load's code running against
the newer one's state. The work is in
`lib/internal/session/crash-record.ts`.

Find a crash with `journalctl --user -t pi -p err`, or the entry in
the session's log, and the starts with
`journalctl --user -t pi -g 'ready in'`, the slow ends with
`journalctl --user -t pi -g 'still ending'`, and who asked each quit
with `journalctl --user -t pi -g 'quitting session'`.
