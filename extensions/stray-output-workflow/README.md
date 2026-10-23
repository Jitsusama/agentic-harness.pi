# Stray Output Workflow

Keeps whatever would be written behind pi's screen off it, and says
whose it was instead.

pi draws its screen by keeping a picture of every row and writing
only what changed. In interactive mode it guards neither standard
output nor standard error, so anything else written to the terminal
lands wherever the cursor is, usually the question bar, and stays
there until something redraws it. pi is one of the writers: its
event bus catches a `pi.events` handler that throws and
`console.error`s the whole stack. Every throwing handler, every
library's warning and every stray `console.log` became junk over the
editor, recorded nowhere and naming no writer anyone could read.

## What It Does

- **Caught:** every `console` method and every direct write to
  standard error, from the moment this extension loads.
- **Kept:** each write goes whole, with the stack that made it, the
  session and a timestamp, into
  `~/.local/state/pi/agentic-harness.pi/stray-output/stray.jsonl`. Past
  4 MB the log moves aside to `stray.jsonl.1`.
- **Said:** one notice in its place, naming the writer, as
  `mesh-workflow's jobs:finished:v1 handler threw: TypeError: ...`.
  The writer is read off the error's own frames first, then the call
  stack, passing over pi's and node's, since pi is only the
  messenger. The same line from the same writer is said once a minute
  at most, and every one is still kept.
- **Left alone:** anything written while pi's TUI does not hold the
  terminal, which is while standard input is not raw. pi stops its
  TUI before printing a crash, and an external editor stops it too,
  so those read as written, as does all of print and RPC mode.

Between a reload's two runtimes, and before a session with a screen
starts, writes are kept and nothing is said. The guard wraps the
console once per process, and a reload only changes who handles what
it catches. See `lib/internal/stray/guard.ts`.

## Finding a Writer

```sh
jq -r '[.at, .writer // "?", .channel // "", .line] | @tsv' \
  ~/.local/state/pi/agentic-harness.pi/stray-output/stray.jsonl
```

Each entry's `text` is the write as it was, and `stack` the frames
that made it.
