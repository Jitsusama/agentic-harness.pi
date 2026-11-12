# Secret Run Workflow

Lets an agent ask Joel for one work secret, given to one command, without
ever holding the value. The `secret_run` tool takes a 1Password reference,
the command as words, why, the folder it runs in, the variable the value
goes in and how long it may run.

## Why

An agent that needs a token to publish a package today reads it from a
file or the environment, so the token sits in the agent's reach and, once
printed, in its model's context and its session log. Here the value goes
from 1Password straight to the command Joel said yes to, and the agent
hears only how it ended.

## How It Works

The tool writes an ask into `$XDG_RUNTIME_DIR/secret-asks/`, in the shape
core's secret-asks daemon reads (`lib/internal/secret-ask.ts`). The daemon
draws it as a line in the launcher's Asks; Joel's key there says yes or
no. On a yes the daemon reads the item and runs the command with it, then
writes an answer beside the ask, which the tool reads for its state, exit
code, why and masked output alone.

The wait is handed off after a minute, as a long command is
(`lib/jobs/hand-off.ts`), so the session keeps hearing Joel and the mesh.
The ask is taken back the moment its call is stopped, its job is stopped
or its session ends, and once its answer is read.

## What It Refuses

- Any ask while the session's commands run outside the agent fence, since
  the fence is what keeps an agent's command from the asks folder and the
  daemon's socket.
- A call from inside a script, which can't hand the wait off.
- A second ask while one waits, so a looping agent can't stack lines on
  Joel's screen.
- The same item and command within an hour of Joel's no.
- Anything the daemon would refuse, before it's written: a variable a
  command's start reads, an empty command, more than 30 minutes, a why
  longer than one line.
- Any ask on a machine where secret-asks doesn't run.
