# Priority Workflow

Keeps pi ahead of the work it starts, and the machine's heavy work
taking turns by the room it needs.

## Why It Exists

pi is something a person works in. The builds, test runs and subagents
it starts are work, and on a busy machine they used to sit in the same
cgroup as pi, so a build pi ran shared the CPU with everything else the
person was using. On one laptop, with sixteen busy threads in an app's
cgroup, a wakeup in pi's terminal waited up to 17.6 ms, against 1.3 ms
once the busy threads sat in an idle cgroup.

## What It Does

Where the machine keeps an idle cgroup for work and names it in
`JOBS_CGROUP`, a path under the account's own systemd user manager such
as `jobs.slice/jobs.service`, every process pi spawns is written into
that cgroup the moment it is spawned, and whatever it starts afterwards
is born there. pi itself stays where it was started.

- **Every spawn.** It wraps `ChildProcess.prototype.spawn`, which every
  asynchronous spawn in the process goes through: the bash tool,
  subagents, language servers and the status line's git alike. A
  synchronous spawn is left alone, since pi blocks on one, as when it
  hands the terminal to an editor.
- **The bash tool's shell moves itself.** A child is written into the
  cgroup just after it starts, and in 200 tries 31 shells had already
  run their first command by then, so what they forked stayed behind.
  `shell-workflow` has the shell write its own pid first, and then all
  200 shells' commands ran in the cgroup.
- **Nothing to set up elsewhere.** Without `JOBS_CGROUP`, off Linux, or
  outside a user manager, nothing changes. A setting naming a cgroup that
  isn't there is said once, at session start. A child that exits before
  it can move is skipped, and so is one spawned while the cgroup is gone
  for a moment, as it is while systemd starts it again; a cgroup that
  refuses a write is not written to again in that process.

core.nix's slices module makes the cgroup and sets the variable.

## The Machine's Queue

Sessions used to take turns at heavy work by hand: they broadcast
"mail a hold", ran scripts that looked every 15 seconds for anyone
else's VM, and ran one VM at a time across the machine. One VM test
waited 35 minutes while 3.7 of 16 cores were busy and 45 of 62 GiB
stood free.

Now every pi session shares one queue in `$XDG_RUNTIME_DIR/jobs`, with
no daemon and no command to learn. When a bash call runs heavy work,
the harness reads its kind from one map, puts a job in the queue, and
the call's shell waits for its turn before it runs anything; pi itself
never waits. A time limit the call was given starts when its turn
does, so the wait never uses it up (see
[shell-workflow](../shell-workflow/)).

| Kind | What it is | Class | Held to need |
| --- | --- | --- | --- |
| vm-test | A VM or a test's driver run here, `run-subtests` | timed | 6 GiB |
| vm-check | A Nix build of a VM test, which the daemon runs | bulk | 6 GiB |
| benchmark | `cargo bench`, `hyperfine` | timed | 2 GiB |
| build | Nix builds and checks, `nixos-rebuild`, `home-manager switch`, `darwin-rebuild`, cargo's builds and tests (aliases, toolchains and flags too), `make -j`, `cmake --build`, `go build` and `go test`, `changed-checks`, `nix-fast-build`, `nix eval` of every check | bulk | 4 GiB |

Watchers such as `cargo watch` and `bacon` are left out, since they
would hold a turn for as long as they watch.

Work that evaluates a whole flake's checks, `nix flake check` and
`nix-fast-build`, is held to 20 GiB whatever its kind, since its
evaluator keeps that heap until it ends. Evaluating every check's
derivation at once, as `nix eval` of `#checks` does, reached 24 GB,
so it is held to 24. `changed-checks` is held to 16: since core #465
it evaluates 40 checks at a time, its runs peaked at 11.7 and 12.5 GiB,
and a chunk of 40 VM tests, the heaviest it can meet, held 13.8.
`changed-checks --build` without `--no-vm` builds VM tests too, so it
is a vm-check.

A command's name need not say it runs a VM test, as `nix flake check`'s
does not, so the queue also learns it from what ran. While a job runs,
the Nix builds it asked for are found by their worker, which the daemon
names after its client's pid, and that client runs in the job shell's
cgroup. A build running qemu, NixOS's test driver, systemd-nspawn, niri
or sway marks the job, and the next time the same work is asked for it
waits as a vm-check: the same checks however the flake is named, or
the same command with any log. Only the latest run that had its turn
decides, so once its checks come from the cache it is a build again.
A check that ran one when it was built alone, named in full or as
`$c.name` the way the integration net asks, is known by name: any
other work asking for it waits as a vm-check too, and is never quick.
A run of several checks that ran one teaches nothing of which, since
nothing in a daemon build says which check it is for. So work that
builds VM checks whose names don't say so, beside others, should run
them as VM work of its own: on 28 October the integration net did
not, and seven VMs ran with no VM turn while twenty VM tests waited
from 23:04 to past 00:48.

What was learned is only a first guess for one `nix build` of checks
named in full, after nothing but `cd`s: before its place in line, its
shell asks Nix what it will build (`nix build --dry-run`, which leaves
out what the store or a cache has) and reads those derivations' system
features (`nix derivation show`). One needing `kvm` or `nixos-test`
runs a VM, whatever its name, so the job waits as a vm-check; none, or
nothing to build, and it waits as a build. The plan runs in the job's
own shell, in jobs, never in the person's programs, within 60 s, and
`queue.json` says `waitingOn: "planning"` meanwhile. When Nix can't
say, or no plan comes within 90 s, the job keeps the learned kind, and
its outcome records `planned: "failed"` with why. A loop over `$c`,
anything assigned in the call, and `nix flake check` aren't planned:
their text can't be asked before they run, and a flake's checks are
known to run VMs. Nothing can make a VM wait once the daemon has
started it, and a pre-build hook that waited would stall all of its
client's builds, so the plan comes before the turn. A dry run itself
is a build, never a VM check.

- **A turn** comes when the memory left past the floors core.nix keeps
  for the person's programs covers the job's need, memory pressure is
  under 10%, and fewer than six VMs run, or four while the person's
  programs stall on memory more than 1% of the time: past four, more
  VMs page what they hold out. It is five for a day once at least
  three VMs that had passed with fewer failed with six or more running,
  twice as often as VMs failed with fewer: one failure is not a
  rate, and 623 runs failed no more often beside eight VMs than beside
  one. The VMs are counted from the
  machine's processes as well as the queue, so a check picked from a
  variable, or a VM a session runs outside the queue, still counts.
  A job's need is its heaviest step's, judged whole as it asks: a
  command that builds `changed-checks` and then runs it from
  `$out/bin` needs the tool's memory, not the build's, and the `what`
  it shows is cut at 120 characters.
  Timed work goes first, then quick work (below), then within each
  class the work of a session another is parked on (the mesh says
  whose, from its wait leases), then the work of a quest put first
  (`quest queue-first`, listed in `first.json` beside `queue.json`,
  each job knowing its quest from the `PI_QUEST` its commands
  carry), then the oldest; a job memory holds back holds everyone
  behind it but quick work. `queue.json` gives each job's `quest`,
  and marks it `first` when that quest is put first.
- **Quick work** is a build that takes seconds: its last run of the
  same work took under a minute, or, never run, it builds checks named
  in full (`.#checks.<system>.<name>`), none a VM test's. The same work
  is the same checks whatever flake reference names them, or else the
  same command past `timeout` and `direnv exec`. A command with a
  heavier step after it is never quick. It goes ahead of other bulk
  work and past a job held back, one quick job at a time while older
  work waits, so a stream of them never starves it. Beside a VM check
  it has a turn of its own, beside the one capped build and whatever
  the CPU pressure, at `max-jobs = 1` and `cores = 2`. From 24 to 26
  October, 69 of the 86 builds that ran under a minute after waiting
  over two waited while a VM check ran, 361 minutes between them,
  with CPU pressure at 40 to 70 against the capped build's 10. Of 458
  builds that rule calls quick, 367 were, and 24 ran over five
  minutes; a slow run makes the next bulk again. `queue.json` marks
  the job `quick`.
- **Only work is read:** a quoted single word, such as a quoted flake
  reference, counts as part of the command. A step that only looks for
  something, such as `pgrep`, `ps`, `grep`, `systemctl` or `echo`,
  or only reads a file, a path or git's history, such as `readlink`,
  `ls`, `cat`, `[ -x ... ]`, `git grep`, `git log` or `git show`,
  counts as no work, however its words read. A heredoc is never the
  step a job is named for. A step that
  sets a variable from `$(...)` is judged by the command inside, so
  `w=$(readlink -f $d/bin/nixos-test-driver)` runs no VM.
- **One capped build beside a VM check** while there is no timed
  cgroup: the queue gates memory, not CPU, and a VM check runs in the
  daemon beside any build that starts, which is how an all-core kernel
  build broke a camera subtest's timing. Holding every build instead
  left five waiting up to 24 minutes with the CPU 72% idle, and a limit
  of 10% held 41 builds five minutes or more from 22:00 on 28 October,
  though over 741 VM runs builds beside raised no failures and VMs
  slowed only past 70% (x1.27). So one
  build at a time starts beside a VM check, while CPU pressure is under
  70% and the person's own programs don't stall on memory, and its Nix
  builds run at `max-jobs = 2` and `cores = 4`, at
  most about 8 cores, or `cores = 2` after a VM failed beside one. The cap is a settings file put first in
  `NIX_USER_CONF_FILES`, ahead of the files Nix reads anyway, so the
  person's nix.conf still holds and an inline `NIX_CONFIG` can't drop
  it; the daemon honours it since the account is a trusted user. Each
  job reads its settings from its own `<id>.capped`, so quick work can
  be held tighter; an empty one, as an older harness writes, means
  `capped.conf`.
  cargo is held to the same cores through `CARGO_BUILD_JOBS`, which a
  `-j` on the command still overrides. The call's output says it ran
  capped, and `queue.json` marks the job
  `capped`, so a VM failing beside one can be traced to it. A build
  from a session on an older harness, whose shell can't read the cap,
  waits for the check instead of running on every core. Other builds
  wait, and a VM check starts beside builds but not past one waiting,
  so a build waits only for the checks already running.
- **One at a time:** turns are given at least 3 seconds apart, and a job
  just started counts its need as taken for a minute while it grows.
- **Timed work** then runs in the cgroup `TIMED_CGROUP` names, or in
  jobs while there is none. A wait of 5 seconds or more is said in the
  call's output.
- **Giving way:** a shell runs its command anyway when its job is given
  up or nobody has kept the queue for two minutes. Nobody keeps it
  while the machine sleeps, so a shell whose clock has jumped gives the
  keepers 10 seconds to wake before that counts. A job ends when its
  shell does, or its session's pi, however either ends. So work the
  command hands off with `setsid -f`, `nohup` or a trailing `&` is
  forgotten once the shell exits, and its memory counts as taken only
  for the minute after its turn.
- **Every session keeps it** every 2 seconds while jobs stand, under a
  lock, and rewrites `queue.json` whole on each change and at least
  every 30 seconds, with a `heartbeat` in epoch seconds. The launcher
  reads that file, and it counts the minutes a job waited today while
  the memory it needed stood free.
- **What others may read:** mycelium's node reads `queue.json` from
  outside the harness to say what its machine can take. Its `v`, `at`,
  `heartbeat`, `machine` and `room` are that contract: a change to any
  of them bumps `v`, a field added to them doesn't, and the rest of the
  file may change without one. A `heartbeat` over two minutes old means
  nobody keeps the queue, so no harness session runs there. `room` says
  whether heavy work would start now, not whether the machine can take
  another session; that is `machine.availableGib` and its `pressure`.
  `machine.over` names the queue's own pressure limits the machine is
  at or past now, `memory` (no job starts) and `cpu` (no build starts
  beside a VM check), so a reader never applies the limits itself, and
  `room` at 0 with `over` empty reads as a full queue, not a pressed
  machine.
- **The room left** is in `queue.json` as `room` (how many more VMs and
  builds would start now) and, as words, in `room`. When a call's heavy
  work has run a minute or more, its shell says that room as it ends,
  and that work independent of each other can run at once, each as its
  own background bash call. The queue only fills the machine with work
  somebody starts: on 22 October, 35 of the 43 minutes the CPU was
  under half busy had no VM running, while agents ran tests one after
  another.
- **How work ended** is kept, one line a job, in `outcomes.jsonl` in
  the workflow's state directory
  (`~/.local/state/pi/agentic-harness.pi/priority-workflow/`): its kind,
  how long it waited and ran, its shell's exit status, whether it was
  capped, the most that ran beside it at once (VMs, builds, capped
  builds, CPU pressure), whether a build it asked for ran a check with
  deadlines (`ranTimed`), and up to how much memory its builds held at
  once (`buildsPeakBytes`, each build's own `memory.peak` added up,
  though those peaks need not have met), and the most its own commands
  held (`ownPeakBytes`, its shell's scope's `memory.peak`: the `nix`
  client's evaluation, cargo, or a VM test run from its driver). Nothing
  yet sizes a turn by either; they are there to measure what the fixed
  sizes should be. The shell writes its exit status as it exits; a
  shell killed outright, or work that sets its own EXIT trap, leaves
  none. The file keeps its newer half past 2 MiB, about a month of
  work. A VM that failed (exit 1 to 125) beside a capped build in the
  last day lowers the cap to 2 cores, since the cap is an estimate, not
  a measurement, but only when the same command, as the queue names it,
  has passed with no capped build beside it. A break copy, a test with
  a feature broken on purpose, fails every time and so never counts.
