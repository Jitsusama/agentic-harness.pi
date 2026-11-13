# Host Soak

A week's turns through one host, then the same turns through plain pi,
for what only a long run shows: memory that keeps growing, latency the
host adds, and records that drift from plain pi's.

- `soak.mts`: the program. Each conversation's turns are typed through
  viewers that attach for a visit of two to eight turns and leave, a
  second viewer joining every third visit. At each checkpoint every
  conversation parks and the host is weighed awake and parked, then each
  wakes by a window, the mesh or its next key, in turn: the windows one
  at a time first, as a person opens one, then the rest together.
  Under `--burst` every one wakes by a window at the same moment instead,
  as a host's conversations do after a switch.
- `turns.ts`: the script, the same on every run of the same sizes, with
  reads, bash, background bash jobs and long answers among the echoes.
- `soak-provider.ts`: the model, an Anthropic-messages endpoint on
  127.0.0.1 that answers without end, so both sides run pi's real
  provider code, at once or at a pace.
- `pace.ts`: how long each answer and each bash command takes and how
  many rounds a turn has under a pace, drawn through a median and a
  90th percentile, the same for the same turn on either side and on
  every run, and how an answer is cut into pieces streamed across its
  time.
- `report.ts`: latencies from the logs, what the screens add to them,
  their percentiles, whether the weighings settle, and the differences
  between each pair of logs.
- `profile.ts`: where each side's time went, from the CPU profiles node
  writes under `--profile`, by area and by function, in all or within a
  stretch of wall time.
- `soak.test.ts`: the soak at its smallest, two conversations of two turns,
  once with no parking, once parked and woken in turn, and once woken
  in a burst, in `pnpm test:host`.

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

## Running at a Real Pace

Without a pace the model answers at once, so each side runs as fast as
it can: a closed loop that measures the host's cost per turn, not what a
person feels. `--answer-ms P50,P90` has each answer take a time drawn
through those percentiles, its words streamed in a piece every 50 ms,
`--tool-ms P50,P90` has each bash command run that long first, and
`--rounds P50,P90` has each turn work through that many rounds before
it answers, a tool call in each, two bash to every read. No drawn time
passes 45 s and no turn passes 60 rounds, and each wait for a turn
widens to fit. The week of Nov 6 to 13 on optimus gave the pace, from
680,045 answers, 425,376 bash runs and their turns in 604 session logs:

```sh
--answer-ms 16007,38871 --tool-ms 541,12263 --rounds 7,55
```

At that pace a turn averages about 25 rounds and 9 minutes, so size a
paced run's turns small: 4 a conversation with `--checkpoints 2` takes
35 to 40 minutes a side, inside `--longest 14400`.

## The Report

It prints a line a checkpoint and the report as one JSON line after
`soak report:`. The report holds:

- `pace`: the pace it ran at, empty for none.
- `opened`: how long opening every conversation took and the host's
  weighing once all had, so its loop figures cover the opening alone
  and the first checkpoint's start after it.

- `checkpoints`: the host's RSS, PSS, swapped PSS, heap used, heap
  total, external and array buffers after its garbage is collected,
  awake and parked, with the bytes the logs hold. The awake weighing
  also says how late the host's loop ran, at its 99th percentile and at
  most, and the share of the time it was busy, since the weighing
  before, the weighings' own collections left out. `windowWakes` times
  each window's wake, from its attach to the host's answer, which waits
  for the whole wake, and from there to its first drawing, with the bytes
  its log held. A mesh wake goes untimed: the host lists a waking
  conversation idle before it has loaded. Under `--burst`, `burstWakes`
  times every window's wake the same way, all opened at once, and
  `afterBurst` weighs the host once all have woken, its loop figures
  covering the burst alone: the bar asks each wake to answer within 5 s
  and the loop never to run more than 1 s late.
- `heap`: whether the heap used, the heap total and RSS settle, awake
  and parked. A parked heap that still climbs in the run's later half is
  a leak; the awake heap grows with the conversations' history, so read
  it against the log bytes. RSS or heap total climbing over a flat heap
  used is pages V8 freed and keeps pooled, not objects held.
- `latency`: each side's 50th and 99th percentile, from a prompt's entry
  to its answer's in the log. pi writes both as each message ends in its
  engine, so these are the engine's own turns, like for like. `paired`
  is what each turn cost hosted: its time less plain pi's for the same
  seeded turn, below 0 where plain pi was slower, with `unpaired` the
  turns plain pi never answered. Both sides play the same seeded
  answers and tools, so this is the host's own cost, where each side's
  p99 is only the run's slowest seeded turn. `screen` says what the
  host's screens add: from the key typed to the prompt's entry
  (`keyToAccepted`) and to the first frame the viewer is sent holding
  the prompt (`keyToDrawn`), and from the answer's entry to the write
  that first draws it (`writtenToDrawn`, below 0 when drawn as it
  streams). The first key after each wake can wait on the wake, as one
  the mesh woke is still loading when it is typed, so `afterWake` times
  those apart and the other two leave them out. `bar` says whether
  each holds: `paired` at most 1 s at the p99, and `keyToAccepted` and
  `keyToDrawn` at most 200 ms; the burst is judged from its checkpoint.
- `turnsTimed`: every hosted turn's own times, plain pi's beside them
  and its key's when a viewer typed it, with how it woke when it was
  the first key since, so a reading the report doesn't make can still
  be made.
- `slowKeys`: the 20 slowest keys whose prompt reached the log over
  1 s after it was typed, each with its turn and times, so a p99 says
  which keys it was. Under `--profile`, `spent` says where the host's
  time went while each waited: its profile's samples within that
  stretch, the profile's own clock laid on the wall's by when the host
  started and stopped.
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
