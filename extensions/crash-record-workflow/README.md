# Crash Record Workflow

What the system's log hears of a pi: how long it took to be ready,
and why it ended when an uncaught error ends it, in its session's
log too, as a `crash` entry, with the stack.

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
- Arms only in plain pi. A host runs many conversations in one
  process and installs what that process listens for itself.

The process keeps one listener, which each load replaces with its
own, so a reload never leaves an older load's code running against
the newer one's state. The work is in
`lib/internal/session/crash-record.ts`.

Find a crash with `journalctl --user -t pi -p err`, or the entry in
the session's log, and the starts with
`journalctl --user -t pi -g 'ready in'`.
