# Shell Workflow

Stops a bash command from holding the session silently. A command still
running after a minute moves to the background: the agent gets its
turn back, and the command's result arrives later as a message of its
own. The agent's shell also has no interactive editor or pager to wait
on.

## How It Works

The extension registers `bash` as pi's own bash tool, built with your
`shellCommandPrefix` and `shellPath` settings. Output truncation, the
saved full output, the rendering and what codemode scripts receive are
all pi's.

What it adds:

- **Hand-off.** A command still running after a minute becomes a
  job (see [job-workflow](../job-workflow/)). The call returns saying
  so, with the last output and how long ago it came, and tells the
  agent not to run it again or run anything that depends on it. When
  the command ends, the job says its exit status, how long it took, its
  last lines and where the full output is.
- **A `background` parameter.** `true` moves the command to the
  background at once. `false` or left out, the one-minute rule
  applies: nothing holds the call longer. `false` once waited however
  long the command took, and models passed it on nearly every call, so
  sessions sat deaf to the person and the mesh for up to half an hour.
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
  turn does, read from a mark the shell leaves as the work begins. It
  stops while the shell's cgroup is frozen, as the jobs door freezes
  work through a call, so a thawed command isn't killed for time it
  never ran. Running out reads as pi's own does: `Command timed out
  after N seconds`. Every other command keeps pi's clock.
- **What other extensions offer.** An extension can offer variables
  for the agent's commands through `offerShellEnvironment` in
  `lib/internal/shell/environment.ts`, read as each command starts.
  The quest workflow offers `TMPDIR`, pointing at the loaded quest's
  scratch. No offer can turn a prompt back on.
- **Guidance.** The tool tells the agent not to pipe output through
  `tail` or `head` (pi already keeps the end and saves the rest), and
  not to sleep to wait for something. Where `JOBS_CGROUP` places its
  commands, it also says not to add `nice`: inside that cgroup `nice`
  only ranks a command against other agents' work, so a niced VM test
  loses to every build beside it.

## The Agent Fence

Within one account, every check a desktop daemon could make is one a
process running as you can forge: the uid a socket reports, the program
a pid runs, the cgroup it sits in, a pipe another process holds. The
compositor hands every client a virtual keyboard, the clipboard and the
screen. So rather than ask each daemon to tell an agent from you, start
a session with `PI_SANDBOX=fence` and each command runs in
[bubblewrap](https://github.com/containers/bubblewrap), around Landlock
through landrun:

- **Its own processes and devices.** A pid namespace and a `/proc` of
  its own, so no other process's files, memory or open pipes, and a
  `/dev` holding only what any program needs, so no TPM (which would
  sign with a key whose handle it could read), camera, microphone or
  security key.
- **No private keys.** `~/.ssh` shows only public keys, its settings
  and the known hosts.
- **No git that runs later.** In each repository in the home folder,
  under `src` four levels down, and in `world`, the settings, hooks,
  `info` and other trees' git folders are read-only. Objects, refs and
  the index stay writable, so commits still work in the session's own
  tree, but not from a command in any other. The tree's `.git` file
  and its links back are read-only too.
- **No desktop.** The runtime folder is an empty one of its own, with
  only the Nix daemon's door for sandboxes bound back, and `NIX_REMOTE`
  points there. Landlock refuses every other socket, an abstract one
  and a signal outside too, so the display, the compositor, the shell's
  ipc, the session and system buses, sound, the keyring, the password
  and clipboard daemons, SSH agents and kitty are out of reach. Name
  lookups through nscd still work. The variables that name them are
  left out, so a command fails at once rather than search.
- **Settings read-only.** `~/.config`, the shell's startup files,
  git's and npm's settings, `~/.ssh`, what is on your `PATH` (`~/.local/bin`,
  the Nix profile, dev's toolchain), the launcher's entries, direnv's
  allow list, `~/.pi/agent`, pi's packages, and the skills and settings
  every agent loads, so nothing it writes runs as you later. The home
  folder itself is read-only, with its other entries bound back
  writable, since a dotfile linked into the store could otherwise be
  deleted and replaced. pi's own file tools are held to the same (see
  the sandbox file interceptor).
- **No new privileges.** A setgid wrapper such as 1Password's `op`
  gains nothing.

Everything else is as it was: the home folder, the work, the network
and the rest of the environment. The strict profile below is for text a
stranger wrote; the fence is for every session. A session asking for
it without bwrap and landrun on `PATH`, or off Linux, runs no command.
It cost about 80 ms a command on a machine at a load of 20 (85 ms
against 8 ms unfenced), most of it bubblewrap's mounts.

Until the SSH agent's proxy lets the fence reach the builders, a
`nix-offload there` call on its own runs outside: the store's own
binary, started by its path with the call's own words and an
environment of its own (home, runtime folder, account, the system's
`PATH`). Anything chained on, quoted or expanded stays fenced, and a
test fails from 13 November while the exemption is still here. git
over SSH and commit signing need the agents, so commit and push with
the work tool, which runs in pi's own process.

## A Strict Sandbox

A session that reads what a stranger wrote (reviewing an outside
change, reading the web, running as a subagent) can be told what to
run by that text, and every command runs as you. Start such a session
with `PI_SANDBOX=strict` and each command runs under Landlock through
[landrun](https://github.com/Zouuup/landrun):

- **No credentials.** Nothing in your home folder is readable but
  git's settings (`~/.gitconfig`, `~/.config/git`, `~/.config/dev`)
  and `~/.config/nix/nix.conf`. Keys, tokens, browser profiles and
  session logs are out of reach. Of your variables, a command keeps only
  those known to be harmless (where things are, how to show them, what
  the queue sets), never one whose name holds a word like TOKEN, KEY or
  AUTH, since your environment holds tokens too. There are two
  exceptions. GitHub: where your machine runs `github-broker`, a command gets an
  hour-long token from its GitHub App, as `GH_TOKEN` and git's helper
  for github.com. It reads code and writes pull requests and issues,
  and can't push, merge or change a setting. The broker's socket stays
  out of reach, so a command can't ask for one itself. Google Cloud:
  where your machine names an account for its agents and so runs
  `gcloud-broker`, gcloud gets that account's hour-long token, its one
  project and a settings folder of the session's own, as
  `CLOUDSDK_AUTH_ACCESS_TOKEN`, `CLOUDSDK_CORE_PROJECT` and
  `CLOUDSDK_CONFIG`, never your own login. A token takes gcloud up to
  15 s to mint, so pi asks in the background from the session's first
  command, and a command naming gcloud with none to hand is told why.
- **No sockets but two.** Name lookups through nscd, and the Nix
  daemon's door for sandboxes, `$XDG_RUNTIME_DIR/nix-untrusted.sock`,
  which takes the caller as untrusted; `NIX_REMOTE` points there. No
  session or system bus, no SSH or signing agent, no terminal remote
  control and no abstract socket. The daemon's own socket trusts your
  account, so passing it would hand over root.
- **Writes only to the work.** The working folder, and a temporary
  folder and a cache of its own under `~/.cache/pi-sandbox`, which
  `TMPDIR` and `XDG_CACHE_HOME` name, and gcloud's settings there. Your own `~/.cache` and `/tmp`
  are out of reach both ways, since they hold tokens, code your shell
  runs at every start, and scripts other sessions run unfenced. No
  signal reaches a process outside the sandbox.
- **The network** stays open.

The strict profile costs 20 to 35 ms a command. The queue still reads the command as
given, and the lines that wait for its turn run outside the sandbox. A
session that asks for it where it can't be had, off Linux or without
landrun on `PATH`, runs no command at all rather than run one unfenced.
The tool tells the agent it is sandboxed, so a refusal reads as the
sandbox rather than a fault.

It runs no command in a working folder that is your home folder or
holds it, whose startup files run outside, nor in one holding its
repository's git folder, whose hooks and settings git runs outside. A
tree the work tool cuts (`work tree`), or a snapshot, keeps its git
folder elsewhere, so a strict session works in one; a plain clone
won't do. Its repository's git folder is readable, so git reads the
history, and never writable, so a strict session commits nothing: a
worktree's own folder there names the repository git uses, and writing
it would hand over your next git command in that tree. The `.git` file
naming it lies in the work, so it counts only when the folder it names
points back at it. Its `TMPDIR` is the sandbox's, not the quest's scratch `tmp`,
so what a command saves there for later lands under
`~/.cache/pi-sandbox/tmp`.
Code written in the working folder can still run later outside, an
`.envrc` once you allow it. The sandbox narrows what a command reaches
now, not what you later run from what it wrote.

pi's own file tools run outside Landlock, so the
[sandbox file interceptor][sandbox-file] holds them to the same fence.

[sandbox-file]: ../sandbox-file-interceptor/README.md

## Starting a Command Without Stalling pi

Starting a process forks the one that starts it, and pi grows past a
gigabyte in a long session: a spawn from it took 36 ms at the median,
against 4 ms from a fresh node, on the thread that reads the person's
keys. So each command goes to `pi-spawner` instead, a small program
core.nix puts in the system's profile, which the harness starts once
for the session. The command runs as it would under pi: in a process
group of its own, with the same folder, variables, stop, time limit and
exit code. Where the program isn't installed or stops, or the session
starts with `PI_SPAWNER=off`, pi starts commands itself.

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
- A minute is one constant, `HAND_OFF_MS` in `hand-off.ts`. It was
  five, chosen from the session logs, where people started aborting
  commands at about seven minutes. On 2026-10-25 it came down to a
  minute, since a session in a call can't be steered: pi hands it
  messages only between tool calls, and questions to sessions sitting
  in long commands waited 13 to 31 minutes.
- Another extension that also registers `bash` would replace this one,
  or be replaced by it, depending on load order.
