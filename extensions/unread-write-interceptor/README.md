# Unread Write Interceptor

Refuses a write that would replace a file its conversation hasn't
read, or one that changed since the conversation last read or wrote
it.

## What It Does

pi's write tool replaces a file whole, whether the agent read it or
not. On 25 November a session wrote a state file of asks over the one
already there, never having read it, and every ask in it was lost.

Each conversation keeps the stamp each file had (its inode, size and
modification time) when it last read, wrote or edited it. A write is
refused when the file is there, holds something, and either has no
stamp or no longer matches it. The refusal says to read it first, or
to change it with edit.

- A new file, or an empty one, has nothing to lose, so it is never
  refused.
- The guard, `unread-write`, redirects: the same write sent again goes
  through, since a file a command of the conversation made is one it
  already knows.
- A host serves several conversations from one load, so each keeps its
  own stamps, dropped when it ends.
