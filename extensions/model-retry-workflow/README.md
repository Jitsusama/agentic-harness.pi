# Model Retry Workflow

Keeps a session going when the model is out for a while. When a model
call fails for a moment and pi's own retries run out, the session
waits and asks again, rather than resting on the error, until a call
answers or you stop it.

## Why

pi retries a failed call three times, 2, 4 and 8 seconds apart, then
ends the turn. A provider that is slow or down for longer outlasts
that. One night, 10 of 12 sessions on a machine had calls end in
"Request timed out.", and twice a turn ended there and the session sat
idle until somebody noticed and told it to carry on.

On 18 November turns still sat idle after relay 502s. The harness's
wait lived only in a timer: a reload between runs, seconds after the
last 502, left three background sessions idle for 3 to 10 hours, and a
host restart took a pending try from two more. The relay's trouble
also came and went for an hour, past the six tries the wait then
allowed.

## What It Does

- **Which failures.** Those pi itself would retry: a timeout, a server
  error, an overloaded or rate-limited provider, a dropped stream. A
  usage limit, a malformed request and a context too long for the
  model are never retried; compaction answers the last.
- **When.** Once the run has settled with no try of pi's left: 30
  seconds after the first failure, doubling to 5 minutes, then every
  5 minutes for as long as the call fails. Each try is a short message
  the model reads, saying the call failed and to carry on. There is no
  last try, so a session left alone through a long outage adds one of
  these every 5 minutes; a failed call bills nothing, and compaction
  takes what they add to the context.
- **What you see.** A notice saying what failed, when the next try is
  and how to stop it, and a ↻ mark in the footer while it waits, with
  the try's number from the second on. Where the window gives no raw
  keys, the notice says only that typing stops it.
- **What ends it.** Typing anything yourself, pressing Escape while it
  waits, or pressing Escape on a run (pi's own quick retries among
  them), stops it and starts the count again from nothing. An Escape
  that closes a dialog or a panel is that dialog's, and a key let go
  is no press. A message an extension sends, the harness's own
  try among them, doesn't. Any run that starts while it waits, such as
  a mesh message waking the session, takes the try's place; if that
  run fails too, the wait goes on from where it was.
- **Across a reload or a restart.** Each wait leaves a `model-retry`
  entry in the session, and a stop leaves one with try 0. When a
  session loads and its last message is a reply that failed for a
  moment, it takes the wait up at the try it was on, no sooner than
  30 seconds from the load so the notice shows before an overdue try
  goes out. A failure more than an hour old with no try pending, or of
  no known age, is left for you to carry on, and so is a load that
  starts with a run under way. A try waiting to be said as the session
  closes is taken back at a reload, and kept by job-workflow at a host
  restart, which says it in the next start; that start then sets no
  wait of its own.

Only a session somebody sits at retries. A subagent and a print run
end with their job, and whoever started them judges the failure.
