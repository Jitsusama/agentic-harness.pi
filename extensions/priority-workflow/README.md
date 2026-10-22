# Priority Workflow

Keeps pi ahead of the work it starts.

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
  it can move is skipped; a cgroup that refuses a write is not written to
  again in that process.

core.nix's slices module makes the cgroup and sets the variable.
