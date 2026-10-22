# Read After Write Interceptor

Reads a file again once an edit or write sent beside it has landed, so
a read never answers from a file caught half written.

## What It Does

pi runs the calls in one batch at once. It queues edits and writes to
the same file behind each other, but not reads, and its writes empty a
file before filling it. A read sent beside an edit of the same file can
therefore find it empty. From 15 to 22 October, 18 reads said a long
file had "1 lines total", and every one had been sent beside an edit
or write of that file. A read without an offset would have answered
with an empty file, as a success.

So a read with a write to the same file beside it waits, after it
runs, for that write to land, then reads again with pi's own read tool
and answers with that. Its writes are the ones still unfinished when
the read was announced and the ones announced while it ran.

- Nothing in a batch can act on another call's answer, so the read
  after the write is the only one the agent can use.
- A read waits at most 30 seconds, then answers as it first did.
- pi announces each call only as it runs when a batch runs one at a
  time, so a read is never left waiting on a write queued behind it.
- A read with no write beside it pays one map lookup.

Silent, like every interceptor: the agent sees the answer it would
have had if it had sent the read after the write.
