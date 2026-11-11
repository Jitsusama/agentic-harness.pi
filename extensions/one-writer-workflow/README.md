# One Writer Workflow

Keeps every conversation's log to one writer: a plain pi refuses to
open a conversation that a live host holds.

## Why

On 10 November at 23:30 a holder revived a session as a plain
`pi --session` while the background host held the same conversation.
Two processes appended to one log, and the plain pi's presence named
its own pid over the host's. Pi has no lock on a log, so nothing
stopped it.

## What It Does

At each session start in plain pi, it looks the conversation up in the
lists the machine's hosts keep (`hosts/<pid>-<start>.json` under the
package's state). A list whose host still runs, judged by its start
ticks so a reused pid never counts, holds what it names. When one
holds this conversation, the pi:

- says which host holds it, by key and pid;
- takes no prompt, typed or given on the command line;
- ends with exit code 78, the code a host refused at start ends with,
  so a holder can take it as final rather than starting it again.

In its terminal, pi's own shutdown puts the screen back first. In
print or RPC mode it exits at once, since pi's shutdown there waits for
a command or a run that must not come.

## Where It Doesn't Apply

- A hosted conversation is its host's own, so a host never refuses it.
- A session with no log has none to share.
- A list left by a host that died holds nothing, so a crashed host never
  keeps a conversation from plain pi.
- A move to pi waits for the host's list to drop the conversation
  before plain pi starts it, so a move is never refused.

The lookup is `lib/internal/session/one-writer.ts`. The mesh uses it
too: a refused pi never publishes a presence, so it can't write over
the host peer's.
