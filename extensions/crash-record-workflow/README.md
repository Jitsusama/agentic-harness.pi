# Crash Record Workflow

Has a pi that an uncaught error ends say why where somebody will
look: in its session's log, as a `crash` entry, and in the system's
log, with the stack.

## Why It Exists

On 11 November about 40 pis died within 13 minutes of one another,
and nothing said why in either the session logs or the journal. pi's
own handler had printed each error to its terminal, which closed
with the window when the session was started again elsewhere, and
added it to `~/.pi/agent/crashes.json`, which nothing reads. The
cause, an unhandled write refusal, was found only by thinking to open
that file.

## What It Does

- Writes each uncaught throw, and each rejection nothing handled, to
  the session's log as a `crash` entry before pi's handler exits.
- Writes the same error, naming the session and its folder, to the
  journal through `systemd-cat` on Linux, or the unified log through
  `logger` on macOS, each taken only from the system's own folders.
  The write waits at most 2 seconds.
- Changes nothing about how the process ends: Node's
  `uncaughtExceptionMonitor` runs before pi's own handler, which
  still prints, records and exits.

The process keeps one listener, which each load replaces with its
own, so a reload never leaves an older load's code running against
the newer one's state. The work is in
`lib/internal/session/crash-record.ts`.

Find a crash with `journalctl --user -t pi -p err`, or the entry in
the session's log.
