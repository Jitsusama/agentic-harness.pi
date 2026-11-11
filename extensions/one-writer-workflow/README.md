# One Writer Workflow

Keeps every conversation's log to one writer: a plain pi refuses to
open a conversation that a host holds, open now or kept for its next
start.

## Why

On 10 November at 23:30 a holder revived a session as a plain
`pi --session` while the background host held the same conversation.
Two processes appended to one log, and the plain pi's presence named
its own pid over the host's. Pi has no lock on a log, so nothing
stopped it.

On 11 November K7 found the same gap after a crash. The host's list
dies with it, but its roster (`host-rosters/<key>.json`) stays, and the
host takes up everything on its roster when systemd starts it again. A
plain pi opened in between would share the log with it.

## What It Does

At each session start in plain pi, it looks the conversation up in the
lists and rosters the machine's hosts keep, under the package's state.
A list (`hosts/<pid>-<start>.json`) whose host still runs, judged by
its start ticks so a reused pid never counts, holds what it names. A
roster holds what it keeps, whether its host runs or not. When either
holds this conversation, the pi:

- says which host holds it, and the command that attaches to it there;
- takes no prompt, typed or given on the command line;
- ends with exit code 78, the code a host refused at start ends with,
  so a holder can take it as final rather than starting it again.

In its terminal, pi's own shutdown puts the screen back first. In
print or RPC mode it exits at once, since pi's shutdown there waits for
a command or a run that must not come.

## Where It Doesn't Apply

- A hosted conversation is its host's own, so a host never refuses it.
- A session with no log has none to share.
- A move to pi waits for the host's list to drop the conversation
  before plain pi starts it. A running host drops it from its roster a
  moment later, so the pi waits up to 2 s for that drop rather than
  refusing the move.

The lookup is `lib/internal/session/writer-hold.ts`, over
`one-writer.ts` (lists) and `host-holds.ts` (rosters). The mesh uses it
too: a refused pi never publishes a presence, so it can't write over
the host peer's.
