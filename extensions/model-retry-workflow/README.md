# Model Retry Workflow

Keeps a session going when the model is out for a few minutes. When a
model call fails for a moment and pi's own retries run out, the
session waits and asks again, rather than resting on the error.

## Why

pi retries a failed call three times, 2, 4 and 8 seconds apart, then
ends the turn. A provider that is slow or down for longer outlasts
that. One night, 10 of 12 sessions on a machine had calls end in
"Request timed out.", and twice a turn ended there and the session sat
idle until somebody noticed and told it to carry on.

## What It Does

- **Which failures.** Those pi itself would retry: a timeout, a server
  error, an overloaded or rate-limited provider, a dropped stream. A
  usage limit, a malformed request and a context too long for the
  model are never retried; compaction answers the last.
- **When.** Once the run has settled with no try of pi's left: 30
  seconds after the first failure, doubling to at most 5 minutes, for
  6 tries, about 17 minutes in all. Each try is a short message the
  model reads, saying the call failed and to carry on.
- **What you see.** A notice saying what failed and when the next try
  is, and a ↻ mark in the footer while it waits, with the try's
  number from the second on. After the sixth fails, a notice says so
  and the session rests.
- **What ends it.** Typing anything, or pressing Escape on a run,
  starts the count again from nothing. Any run that starts while it
  waits, such as a mesh message waking the session, takes the try's
  place; if that run fails too, the wait goes on from where it was.

Only a session somebody sits at retries. A subagent and a print run
end with their job, and whoever started them judges the failure.
