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
never waits.

| Kind | What it is | Class | Held to need |
| --- | --- | --- | --- |
| vm-test | A VM or a test's driver run here | timed | 6 GiB |
| vm-check | A Nix build of a VM test, which the daemon runs | bulk | 6 GiB |
| benchmark | `cargo bench`, `hyperfine` | timed | 2 GiB |
| build | Nix builds and checks, `nixos-rebuild`, cargo's builds | bulk | 4 GiB |

- **A turn** comes when the memory left past the floors core.nix keeps
  for the person's programs covers the job's need, memory pressure is
  under 10%, and fewer than two VMs run. The VMs are counted from the
  machine's processes as well as the queue, so a check picked from a
  variable, or a VM a session runs outside the queue, still counts.
  Timed work goes first, then the oldest; a job memory holds back holds
  everyone behind it.
- **Only work is read:** a quoted single word, such as a quoted flake
  reference, counts as part of the command. A step that only looks for
  something, such as `pgrep`, `ps`, `grep`, `systemctl` or `echo`,
  counts as no work, however its words read.
- **One capped build beside a VM check** while there is no timed
  cgroup: the queue gates memory, not CPU, and a VM check runs in the
  daemon beside any build that starts, which is how an all-core kernel
  build broke a camera subtest's timing. Holding every build instead
  left five waiting up to 24 minutes with the CPU 72% idle. So one
  build at a time starts beside a VM check, while CPU pressure is under
  10%, and its Nix builds run at `max-jobs = 2` and `cores = 4`, at
  most about 8 cores. The cap is a settings file put first in
  `NIX_USER_CONF_FILES`, ahead of the files Nix reads anyway, so the
  person's nix.conf still holds and an inline `NIX_CONFIG` can't drop
  it; the daemon honours it since the account is a trusted user. The
  call's output says it ran capped, and `queue.json` marks the job
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
  up or nobody has kept the queue for two minutes. A job ends when its
  shell does, or its session's pi, however either ends. So work the
  command hands off with `setsid -f`, `nohup` or a trailing `&` is
  forgotten once the shell exits, and its memory counts as taken only
  for the minute after its turn.
- **Every session keeps it** every 2 seconds while jobs stand, under a
  lock, and rewrites `queue.json` whole on each change and at least
  every 30 seconds, with a `heartbeat` in epoch seconds. The launcher
  reads that file, and it counts the minutes a job waited today while
  the memory it needed stood free.
- **The room left** is in `queue.json` as `room` (how many more VMs and
  builds would start now) and, as words, in `room`. When a call's heavy
  work has run a minute or more, its shell says that room as it ends,
  and that work independent of each other can run at once, each as its
  own background bash call. The queue only fills the machine with work
  somebody starts: on 22 October, 35 of the 43 minutes the CPU was
  under half busy had no VM running, while agents ran tests one after
  another.
