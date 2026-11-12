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
- `report.ts`: latencies from the logs, their percentiles, whether the
  weighings settle, and the differences between each pair of logs.
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

- `checkpoints`: the host's RSS, PSS, swapped PSS and heap after its
  garbage is collected, awake and parked, with the bytes the logs hold.
- `heap`: whether the parked heap, the awake heap and the parked RSS
  settle. A parked heap that still climbs in the run's later half is a
  leak; the awake heap grows with the conversations' history, so read it
  against the log bytes.
- `latency`: each side's 50th and 99th percentile, from a prompt's entry
  to its answer's in the log.
- `parity`: each conversation's log against plain pi's, entries aligned
  by type, with ids, times and each side's folder left out.
- `faults`, `hostErrors` and `plainErrors`: what went wrong.

The host's turns come through viewers and pi's screens, plain pi's
through RPC, so a latency gap holds the screens' cost as well as the
host's. The host also loads the fixture's own command extensions.
