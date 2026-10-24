# Shell Workflow

Stops a bash command from holding the session silently. A command still
running after five minutes moves to the background: the agent gets its
turn back, and the command's result arrives later as a message of its
own. The agent's shell also has no interactive editor or pager to wait
on.

## How It Works

The extension registers `bash` as pi's own bash tool, built with your
`shellCommandPrefix` and `shellPath` settings. Output truncation, the
saved full output, the rendering and what codemode scripts receive are
all pi's.

What it adds:

- **Hand-off.** A command still running after five minutes becomes a
  job (see [job-workflow](../job-workflow/)). The call returns saying
  so, with the last output and how long ago it came, and tells the
  agent not to run it again or run anything that depends on it. When
  the command ends, the job says its exit status, how long it took, its
  last lines and where the full output is.
- **A `background` parameter.** `true` moves the command to the
  background at once; `false` waits however long it takes, as bash
  always did. Left out, the five-minute rule applies.
- **No interactive programs.** The agent's commands run with
  `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `EDITOR` and `VISUAL` set to
  `true`, `PAGER`, `GIT_PAGER`, `GH_PAGER` and `MANPAGER` set to `cat`,
  and `GIT_TERMINAL_PROMPT=0`. Git keeps its default message where it
  has one and fails fast where it has none, rather than waiting on an
  editor nobody will close. `GIT_ASKPASS` and `SSH_ASKPASS` are empty
  and `SSH_ASKPASS_REQUIRE=never`, so a missing credential fails at
  once instead of opening a prompt window on your screen; credential
  helpers still run first. Only the agent's commands get these: pi's
  own editor and your shell are untouched, and a command that sets one
  itself still wins.
- **Behind what you use.** Where `priority-workflow` is putting what
  pi starts into the machine's cgroup for work, the shell moves itself
  there before it runs the command, so nothing the command forks is
  left behind at pi's priority.
- **A time limit that measures the run.** Heavy work waits in its shell
  for a turn in the machine's queue before it runs, and pi's own clock
  counted that wait: hour-long jobs died at their hour having never
  started. For a command the queue holds, the clock starts when its
  turn does, read from a mark the shell leaves as the work begins, and
  running out reads as pi's own does: `Command timed out after N
  seconds`. Every other command keeps pi's clock.
- **What other extensions offer.** An extension can offer variables
  for the agent's commands through `offerShellEnvironment` in
  `lib/internal/shell/environment.ts`, read as each command starts.
  The quest workflow offers `TMPDIR`, pointing at the loaded quest's
  scratch. No offer can turn a prompt back on.
- **Guidance.** The tool tells the agent not to pipe output through
  `tail` or `head` (pi already keeps the end and saves the rest), and
  not to sleep to wait for something.

## Stopping a Command

Before it moves, Escape stops it as always. After it moves, `/jobs`
stops it for the person, the `jobs` tool's `stop` for the agent, and
the session ending too. Each kills the command's whole process group,
children and grandchildren alike. On Linux it also kills whatever left
that group, as `timeout`, `setsid` and some build clients do: every
command's environment carries a mark of its own in `PI_BASH_CALL`, and
a stop or a timeout kills every process still carrying it. A command
that ends by itself keeps what it left running. The hand-off answer tells the agent
to use the tool and never to kill the shell by hand, which would leave
what the command started running. A reload does not: the
command keeps running, and its result arrives in the reloaded session
(see [job-workflow](../job-workflow/#through-a-reload)). A timeout the
agent passed still applies in the background.

## Limits

- Calls a codemode script makes are never moved, since the script needs
  the real result.
- Without job-workflow loaded nothing is moved, and bash behaves as pi's
  does.
- Five minutes is one constant, `HAND_OFF_MS` in `hand-off.ts`, chosen
  from the session logs, where people started aborting commands at
  about seven minutes.
- Another extension that also registers `bash` would replace this one,
  or be replaced by it, depending on load order.
