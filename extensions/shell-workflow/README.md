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
screen. So rather than ask each daemon to tell an agent from you, each
command runs in
[bubblewrap](https://github.com/containers/bubblewrap), around Landlock
through landrun. On Linux it is the default: a session that names no
`PI_SANDBOX` is given `PI_SANDBOX=fence` as it loads, and its children
inherit it. Where bubblewrap or landrun isn't in the system's own
profile, the session runs unfenced and says so once. `PI_SANDBOX=off`
runs one session unfenced by choice. Either way the session leaves
`unfenced sandbox=<off|none> session=<id>` in the system's log under
`pi-fence`, so an opt-out shows. Fenced, a command has:

- **Its own processes and devices.** A pid namespace and a `/proc` of
  its own, so no other process's files, memory or open pipes, and a
  `/dev` holding only what any program needs, so no TPM (which would
  sign with a key whose handle it could read), camera, microphone or
  security key.
- **No private keys.** `~/.ssh` shows only public keys, its settings
  and the known hosts.
- **No git that runs later.** `~/src` and `~/world` are read-only, so
  a command makes no repository there and changes no checkout's files;
  work in a tree the work tool cuts. Each git folder there is
  read-only but for `objects`, `refs`, `logs`, `lfs` and `rr-cache`,
  so a commit still works in the session's own tree, which is bound
  back writable, but nothing can plant a `commondir`, a submodule's
  git folder or a setting. In a repository elsewhere in the home
  folder the settings, hooks, `info` and trees' git folders are
  read-only. The tree's `.git` file and its links back are read-only
  too. Other quests' scratch folders
  are read-only, the session's own quest's bound back, since clones
  there run git outside the fence for their own sessions.
- **No git of its making run outside.** pi runs git outside the fence
  (the work and review tools, the write classifier, verification), so
  it runs it only where a command couldn't have set what git runs
  (`lib/internal/tree-git.ts`). A tree's `.git` file counts only when
  the folder it names, in its repository's `worktrees`, names it back,
  and git is then told both folders outright. A tree where the work
  tool cuts them must come from a repository the fence guards, in every
  session; a fenced session's git runs only in such repositories, which
  are those under `~/src` and `~/world`. Cut a tree from a checkout
  there, not from a clone in a scratch folder. Every such git runs
  with `core.fsmonitor=false`, and refuses a git folder holding a
  `commondir`, which would have git read another folder's settings.
- **No desktop.** The runtime folder is an empty one of its own, with
  three doors bound back: the Nix daemon's door for sandboxes, which
  `NIX_REMOTE` points at; the SSH agent's proxy, which signs only
  logins to the hosts it's told of; and the jobs broker
  (`daemons/jobs-broker.sock`), which puts the process asking, as the
  kernel names it, into a scope of its own in its quest's work slice,
  and says how named units stand, in place of the user's bus. Landlock refuses every other socket, an abstract one
  and a signal outside too, so the display, the compositor, the shell's
  ipc, the session and system buses, sound, the keyring, the password
  and clipboard daemons, SSH agents and kitty are out of reach. Name
  lookups through nscd still work. The variables that name them are
  left out, so a command fails at once rather than search.
- **Settings read-only.** `~/.config`, the shell's startup files,
  git's and npm's settings, `~/.ssh`, what is on your `PATH` (`~/.local/bin`,
  the Nix profile, dev's toolchain), the launcher's entries, direnv's
  allow list, `~/.pi/agent`, pi's packages, and the skills and settings
  every agent loads, so nothing it writes runs as you later. So are
  the programs' entries read as you later: zsh's completion dump,
  dbus's services, nvim's site plugins, the browser's certificates in
  `~/.pki`, and `~/.kube`, `~/.aws`, `~/.gnupg`, `~/.gradle`,
  `~/.docker` and `~/.cargo`, whose settings run a credential command
  or a build, and `~/.rustup`, `~/.mozilla` and `~/.bundle`, whose
  toolchains, messaging hosts and plugins run as you. Their caches
  (kube's, aws's and bundler's) are bound back writable,
  and cargo and gradle get homes of their own in the sandbox's cache,
  since cargo builds the sources it extracted without checking them
  again. A deeper read-only folder is made first where its top entry
  is there, so a command can't make one that wasn't. The home folder
  itself is read-only, with its other hidden
  entries bound back writable, since a dotfile linked into the store
  could otherwise be deleted and replaced. pi's own file tools are held to the same (see
  the sandbox file interceptor).
- **No repositories where you browse.** The home folder's visible
  entries (`~/Downloads`, `~/Documents` and the rest) are read-only
  but the one the session works in. A repository a command made in
  `~/Downloads` could name a clean filter in its settings, which your
  prompt's `git status` would run the moment you entered it, and
  `core.fsmonitor=false` stops no filter. Hidden entries, where
  programs keep their caches and state, stay writable.
- **No moves between cgroups.** `/sys/fs/cgroup` is read-only, so a
  command reads where it stands but moves no process and changes no
  limit. pi places a command's work, its queue's turn and a World
  walk's shared slice outside the fence, before it starts.
- **No new privileges.** A setgid wrapper such as 1Password's `op`
  gains nothing.

Everything else is as it was: the home folder's hidden entries, the
work, the network and the rest of the environment. The strict profile below is for text a
stranger wrote; the fence is for every session. A session asking for
it without bwrap and landrun on `PATH`, or off Linux, runs no command.
It cost about 80 ms a command on a machine at a load of 20 (85 ms
against 8 ms unfenced), most of it bubblewrap's mounts.

Until a broker holds the builders' key, two kinds of `nix-offload
there` call run outside, alone: derivations already in the store
(`nix-offload there <drv>^*`), with only a build's own flags (`-L`,
`--keep-going`, `--print-out-paths`, `--bulk`, `--first`,
`--never-ask`); and, from a tree the work tool holds for the session,
its commit, as `--changed` alone or a `--run` whose copies and program
are store paths. A commit goes with `NIX_OFFLOAD_LENT_ONLY=1`, set by
the fence, so it reaches a lent builder or nothing, never an evaluator
of yours or this machine, and nix-offload sends its committed objects
alone. It runs the store's own binary, started by its path
with the call's own words and an environment of its own (home, runtime
folder, account, the system's `PATH`), and a test fails from 28
November while the exemption is still here. A flake never goes out:
nix-offload sends one that isn't a git tree, or any `path:` one, as
its whole folder read as you. Nor does a checkout's commit, since its
refs are a command's to point anywhere. Any of these, alone, is
refused, saying to evaluate inside the fence first (`nix eval --raw
<flake>#<attribute>.drvPath`) and to hand on each derivation as
printed, or to send a held tree's commit; one with `--here`, `--here-when-idle` or `--outlive` builds
fenced, here, as any build does, and anything chained on, quoted or
expanded stays fenced. One `cd` into a tree the work tool holds may
come before the call, provided the tree is named without a link and
its `.git` file, its git folder's way back and its `commondir` agree.
Whatever git nix-offload runs is held to that tree's git folder
(`GIT_DIR`), or that of a checkout the fence guards, and anywhere else
to one that can't exist, so a `.git` rewritten mid-run is never read. git
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
keys. A session started with `PI_SPAWNER=on` hands each command to
`pi-spawner` instead, a small program core.nix puts on the PATH, which
the harness starts once for the session. The command runs as it would
under pi: in a process group of its own, with the same folder,
variables, stop, time limit and exit code. Where the program isn't on
the PATH or stops, pi starts commands itself, as it does without the
variable. A reload or a new session retires its load's `pi-spawner`,
which closes once the commands it runs have ended, so a background
command outlives the reload. Each load, as it starts, stops any
`pi-spawner` its pi started that runs nothing, as loads from before
retiring was possible left them, whether or not it runs one itself: a
pi that ran one earlier and runs without it now would keep that one
idle until it ends. A shared host running `pi-spawner` stops none,
since there they are other conversations'.

## Stopping a Command

Before it moves, Escape stops it as always. After it moves, `/jobs`
stops it for the person, the `jobs` tool's `stop` for the agent, and
the session ending too. Each kills the command's whole process group,
children and grandchildren alike. On Linux it also kills whatever left
that group, as `timeout`, `setsid` and some build clients do: every
command's environment carries a mark of its own in `PI_BASH_CALL`, and
a stop or a timeout kills every process still carrying it. A command
that ends by itself keeps what it left running. A process moved out
on purpose is spared: one whose cgroup is outside pi's own and outside
the slice `JOBS_CGROUP` puts work in, as `systemd-run --user --scope`
makes. `setsid`, `nohup`, the jobs sorter's scopes and
`jobs-broker run`'s stay in that slice, so they still die; a pi host
restarting spares the same, by the same rule. The hand-off answer tells the agent
to use the tool and never to kill the shell by hand, which would leave
what the command started running. A reload does not: the
command keeps running, and its result arrives in the reloaded session
(see [job-workflow](../job-workflow/#through-a-reload)). A timeout the
agent passed still applies in the background.

## Through a Move

A command's output reaches pi through a pipe, and a running process's
output can't be sent elsewhere once it has started. So each command pi
starts itself keeps itself on disk from its start, ready for a move to
carry it to a host (see
[job-workflow](../job-workflow/#through-a-move)). `keeping.ts` runs it
under a stub that writes its shell's pid, copies its output through
`tee -p` into a file beside what pi reads, and writes its exit status
as it ends. The command runs in a subshell, so its own `exit` or exit
trap can't skip the status line, and `tee` ignores the broken pipe a
moved pi leaves.

- **Where:** a folder of the owner's alone, under
  `$XDG_STATE_HOME/pi/agentic-harness.pi/shell-workflow/kept`, each
  file 0600, never in `/tmp`, since they hold what commands printed.
- **How much:** once the output passes 1 MiB its tail is rolled into an
  `.old` file and the copy starts again, so at most 2 MiB are kept,
  the tail as pi's own bash keeps it. A few bytes written in the
  instant of a roll can be lost.
- **For how long:** a call that ends in its own pi removes its files as
  it ends. A carried one's go once its end is said where it was
  carried, or once it is stopped. Handing one on marks it with a
  `.carried` file holding the call's own mark, so a host reaping what a
  released conversation started spares everything carrying that mark. Files left a week, by a pi killed outright, are swept
  as a session starts.
- **Where not:** commands `pi-spawner` starts, and any where `tee`
  lacks `-p` or the shell isn't bash, run as before and hold a move.

## Limits

- Calls a codemode script makes are never moved, since the script needs
  the real result.
- Nor are a print (`pi -p`) or JSON run's, `background` included: the
  run exits once its prompts are done, which would kill a moved command
  before its result was heard. A long command holds such a run instead.
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
