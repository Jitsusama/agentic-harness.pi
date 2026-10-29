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

A bash call is rewritten into
`nix-offload there [-L] [--keep-going] github:<owner>/<repo>/<rev> <checks>`
when all of these hold:

- it is one `nix build --no-link` of `.#checks.<system>.<name>`,
  optionally under `direnv exec .`, with no flag past `-L`,
  `--print-build-logs`, `--keep-going` or `-k`, and the machine
  queue reads it as a VM check;
- it runs in the repository's top folder, no tracked file differs
  from HEAD, and a remote branch contains HEAD;
- origin is a GitHub repository named in config;
- a builder stands in `/run/nix-offload/machines`. While one is
  being lent, the call waits for it, for at most the queue's three
  minutes from the lend's start.

Its redirections are kept, and it prints
`remote-check: sent to the lent builder by commit <rev>` on stderr
first. Anything else runs as written, through the machine queue,
whose wait for VM room is what lends a builder. If the builder
can't be reached when the command runs, `nix-offload there` builds
here instead and says so; that build takes no turn in the queue.

Only VM checks go: a quick check here takes seconds, where a set
of them took about 28 s on the builder.

## Config

In the package config (`~/.config/pi/agentic-harness.pi/config.json`),
name each public repository as `Owner/repo`:

```json
{ "sections": { "remote-checks": { "repos": ["Owner/repo"] } } }
```

None are named by default, so nothing is sent until one is. Name
only public repositories: the builder fetches the commit from
GitHub without your credentials.
