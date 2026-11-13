# Host Soak

A week's turns through one host, then the same turns through plain pi,
for what only a long run shows: memory that keeps growing, latency the
host adds, and records that drift from plain pi's.

- `soak.mts`: the program. Each conversation's turns are typed through
  viewers that attach for a visit of two to eight turns and leave, a
  second viewer joining every third visit. At each checkpoint every
  conversation parks and the host is weighed awake and parked, then each
  wakes by a window, the mesh or its next key, in turn.
- `turns.ts`: the script, the same on every run of the same sizes, with
  reads, bash, background bash jobs and long answers among the echoes.
- `soak-provider.ts`: the model, an Anthropic-messages endpoint on
  127.0.0.1 that answers without end, so both sides run pi's real
  provider code.
- `report.ts`: latencies from the logs, what the screens add to them,
  their percentiles, whether the weighings settle, and the differences
  between each pair of logs.
- `profile.ts`: where each side's time went, from the CPU profiles node
  writes under `--profile`, by area and by function.
- `soak.test.ts`: the soak at its smallest, two conversations of two turns
  with no parking, in `pnpm test:host`.

## Running a Week

Size the turns from a week of real logs: one count a conversation, the
busiest among them, ten conversations at least. Run it on a lent builder,
never on a laptop someone uses, from a commit pushed to the harness:

```sh
runtime=$(readlink -f ~/.local/state/pi-host/runtime)
nix-offload there --never-ask --run --copy "$runtime" --longest 14400 -- \
  nix shell nixpkgs#nodejs_24 nixpkgs#pnpm nixpkgs#fd nixpkgs#ripgrep -c sh -c "
    pnpm install --frozen-lockfile > /dev/null 2>&1 || pnpm install --frozen-lockfile
    PI_HOST_RUNTIME=$runtime node --no-warnings tests/host/soak/soak.mts \
      --turns 120,60,40,40,30,30,20,20,10,10 --checkpoints 8"
```

It prints a line a checkpoint and the report as one JSON line after
`soak report:`. The report holds:

- `checkpoints`: the host's RSS, PSS, swapped PSS, heap used, heap
  total, external and array buffers after its garbage is collected,
  awake and parked, with the bytes the logs hold. The awake weighing
  also says how late the host's loop ran, at its 99th percentile and at
  most, and the share of the time it was busy, since the weighing
  before, the weighings' own collections left out.
- `heap`: whether the heap used, the heap total and RSS settle, awake
  and parked. A parked heap that still climbs in the run's later half is
  a leak; the awake heap grows with the conversations' history, so read
  it against the log bytes. RSS or heap total climbing over a flat heap
  used is pages V8 freed and keeps pooled, not objects held.
- `latency`: each side's 50th and 99th percentile, from a prompt's entry
  to its answer's in the log. pi writes both as each message ends in its
  engine, so these are the engine's own turns, like for like. `screen`
  says what the host's screens add: from the key typed to the prompt's
  entry, from the answer's entry to the write that first draws it at the
  viewer (below 0 when drawn as it streams), and from key to drawing. A
  turn whose first key wakes its conversation is left out of `screen`.
- `timeSpent`, under `--profile`: each side's busy and idle time and its
  busiest areas and functions, plain pi's processes summed.
- `parity`: each conversation's log against plain pi's, entries aligned
  by type, with ids, times and each side's folder left out. `unexpected`
  counts the differences outside the places that differ on every run
  (an entry's source, a job's id, the journal's trace), and `first`
  names those before the rest.
- `faults`, `hostErrors` and `plainErrors`: what went wrong.

The host draws its screens on the same event loop its engines run on,
and serves every conversation from one process where plain pi runs one
a conversation, so its engine turns hold both; a run of one
conversation, with `--profile`, tells them apart. The host also loads
the fixture's own command extensions.
