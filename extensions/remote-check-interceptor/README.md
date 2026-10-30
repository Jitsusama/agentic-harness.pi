# Remote Check Interceptor

Sends a session's VM checks of a public repository to the lent
builder by commit, rather than running them on this machine.

Through Nix's build hook, a VM check's inputs built here go up
first: one took 1025 s that way, almost all of it uploading,
against 60 s here. Built on the builder from the pushed commit,
which it fetches itself, the same check took 55 to 67 s with
4 KB sent. `nix-offload there`, from core's nix-offload module,
does that.

## What It Sends

Each step of a bash call that builds VM checks is rewritten, in its
own place, into
`nix-offload there [-L] [--keep-going] github:<owner>/<repo>/<rev> <checks>`
when all of these hold:

- it is a `nix build --no-link` of one flake's checks, optionally
  under `timeout <duration>` or `direnv exec .`, with no flag past
  `-L`, `--print-build-logs`, `--keep-going` or `-k`, and the
  machine queue reads it as a VM check;
- the flake's folder is known from the command alone: `.#`,
  `git+file://$PWD#` or `path:$T#`, following plain variables set
  earlier in the command and its `cd`s;
- that folder is the repository's top. With no tracked file
  differing from HEAD (nor an untracked one, for `path:`), and HEAD
  on a remote branch, it goes as `github:<owner>/<repo>/<rev>`.
  Otherwise, where `nix-offload there --takes` says `tree`, it goes
  as the folder itself, and `there` sends the commits GitHub lacks,
  and the uncommitted changes, as a small git bundle. A `git+file://` flake pinned
  with `?rev=` is of that commit, whatever the tree holds, so only
  the commit need be pushed: written out, set earlier as
  `R=$(git rev-parse <ref>)`, or written in place as
  `?rev=$(git rev-parse <ref>)`, which is the one command the
  reader runs, and it only reads;
- origin is a GitHub repository named in config;
- a builder stands in `/run/nix-offload/machines`. While one is
  being lent, the call waits for it, for at most the queue's three
  minutes from the lend's start. Where `--takes` says `wants`,
  `there` asks for a builder itself and waits, so this is skipped.

A `run-subtests` step becomes `run-subtests --there` where
`--takes` says `tree`, `apply` and `out`: the run, its driver's
machines included, is built on the builder and its pictures copied
back. One asking for a prompt (`-I`) or kept machines (`-K`) runs
here.

A piped step is sent too, since `nix-offload there` prints the
build's log as `nix build` would. A step in the background, in a
subshell or loop, or naming its check through something only
running it would show, runs as written.
Its redirections are kept, and the call prints
`remote-check: N checks sent to the lent builder from its commit` on
stderr first. Anything else runs as written, through the machine queue,
whose wait for VM room is what lends a builder. If the builder
can't be reached when the command runs, `nix-offload there` builds
here instead and says so; that build takes no turn in the queue.

Only VM checks go: a quick check here takes seconds, where a set
of them took about 28 s on the builder.

Where a call runs is decided once for it, in
`lib/internal/priority/send.ts`, and the mesh reads the same
answer. pi runs the mesh's handler first, so otherwise a check
bound for the builder would be leased as VM work here, and a
subagent under a hold on this machine's VM work held back.

## Config

In the package config (`~/.config/pi/agentic-harness.pi/config.json`),
name each public repository as `Owner/repo`:

```json
{ "sections": { "remote-checks": { "repos": ["Owner/repo"] } } }
```

None are named by default, so nothing is sent until one is. Name
only public repositories: the builder fetches the commit from
GitHub without your credentials.
