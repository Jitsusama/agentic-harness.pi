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
  as a host's conversations do after a switch. Each conversation's first
  key waits a seeded draw within one median turn at the pace, on either
  side, so they start as a person comes to them rather than in the same
  instant; with no pace they start at once. Under `--restart`, once the
  turns are done every conversation parks, the host restarts on the same
  state, and the fresh host is timed to its socket answering and to
  every conversation woken by a window at once. Under `--restart-mid`,
  every conversation's first turn after the middle checkpoint is held
  mid-answer while the host restarts as systemd restarts it, and the
  fresh host is timed to its socket and to each cut-off turn answered as
  durable carries it on; a turn the person drives (a steer, an abort, a
  compaction) is typed after the restart instead. Each side warms
  jiti's cache before its timed run, as a live host's stays warm, and
  says those starts apart as the cold open; `--cold` leaves it cold.
- `turns.ts`: the script, the same on every run of the same sizes, with
  reads, bash, background bash jobs and long answers among the echoes,
  and a person's own moves: a steer typed while its turn runs a tool, an
  Escape that aborts a turn, and `/compact` with a focus naming the turn.
  The provider holds a steer's or an abort's answer until the steer
  shows pending or the abort has cut it, on either side, so both land
  mid-turn the same way each run.
- `soak-provider.ts`: the model, an Anthropic-messages endpoint on
  127.0.0.1 that answers without end, so both sides run pi's real
  provider code, at once or at a pace.
- `soak-real.ts`: the real-model slice, under `--real MODEL`: the
  provider passes each request on to MODEL at the AI proxy, the soak's
  rules added to the system prompt, and counts every refusal.
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
- `week.json` and `week.ts`: a real week's turns, the prompts typed in
  each of 594 session logs of 7 to 14 November on optimus, and how they
  are cut into seven days of 20 conversations, each conversation one of
  the day's busiest sessions with quiet ones after it.
- `day.ts` and `day.mts`: a day's run, its turns from `week.ts` and what
  its run left: the report cut into the files a reader checks it by, and
  the day's figures, with the bursts and the opening's loop beside the
  bar.
- `soak.test.ts`: the soak at its smallest, two conversations of two turns,
  once with no parking, once parked and woken in turn, and once woken
  in a burst and through a restart; and two of ten turns, which take
  every kind through a restart mid-run; in `pnpm test:host`.

## Running a Day of the Week

`scripts/soak-day.sh DAY OUT` runs day DAY (1 to 7) of the real week on
lent builders from the commit checked out, in two runs of a lender each:
the day's turns unpaced, with a burst of wakes at each of 24
checkpoints, a restart mid-run and one at the end, then 20 conversations
of 4 turns at the real pace below. Each run's lines go to `OUT/<run>.log`
and its report, cut into files, to `OUT/<run>/`. Run it under
`systemd-run --user --scope`, so nothing that restarts the session
running it cuts it off.

## Running by Hand

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

## Running With a Real Model

The script's model takes any conversation; a real API refuses one whose
tool results don't follow their calls or whose signed thinking changed,
which is how a host that carried, parked or restored a conversation
wrongly shows. `--real MODEL` passes every request on to MODEL at the AI
proxy (`SHOPIFY_PI_PROXY_ORIGIN`, or `https://proxy.shopify.ai`), with
the soak's rules after pi's system prompt telling the model what each
kind of turn asks of it, and thinking on at `low`. Each refusal is a
fault. It takes the key from `SHOPIFY_PROXY_KEY` in its own environment
and sends it only in each request's header to the proxy: neither side's
sealed home has it. A lender has no key, so run it on this machine, in
sealed hosts of its own, under `systemd-run --user --scope`, and keep it
small: claude-haiku-5-5 takes about a dime a million tokens read.

`scripts/soak-real.sh MODEL OUT` runs the day's slice so: 4
conversations of 10 turns through a restart mid-run and one at the end,
once the machine's memory isn't under pressure, its lines to
`OUT/real.log` and its report, cut into files as a day's are, to
`OUT/real/`. At about 30,000 tokens a request, its 120 or so requests
cost well under a dollar.

```sh
systemd-run --user --scope -- scripts/soak-real.sh claude-haiku-5-5 "$out"
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
- `coldOpen`, unless `--cold`: each side's first start on a cold jiti
  cache, which no live start pays, since a live host keeps the
  harness's transpiled files in its TMPDIR from one start to the next.
  `hosted` is a host in a seal of its own opening one conversation, and
  its loop's worst while it did; `plainMs` is one plain pi starting in
  plain's seal. Each side's cache is warm before its timed run, so these
  stay out of `opened` and the bar.
- `opened`: how long opening every conversation took, one after
  another, each open answered before the next is asked, and the host's
  weighing once all had, so its loop figures cover the opening alone
  and the first checkpoint's start after it. A storm of wakes all at
  once is `burstWakes` under `--burst` and `restart.wakes` under
  `--restart`.

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
- `restart`, under `--restart`: a restart's time, read the same on
  every architecture. `toSocketMs` runs from the fresh host's start to
  its socket answering, `parkedAtStart` counts the conversations it held
  parked then, a fault when not all, `wakes` times each one's wake by a
  window, all opened at once, as `burstWakes` does, `allAnsweredMs` runs
  from the start to the last of them idle, and `after` weighs the host
  through them.
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
  p99 is only the run's slowest seeded turn. A whole turn's cost can
  hide a stall in a long turn's sum, or spread many rounds' small
  costs into what reads as one, so `steps` pairs each round, from a
  prompt or a tool's result to the next answer, and each tool, from an
  answer to its call's result, with plain pi's at the same place in the
  same turn, `rounds` and `tools` apart, each with its largest; a turn
  whose two sides took different steps pairs none and is counted
  `unpaired`. `screen` says what the
  host's screens add: from the key typed to the prompt's entry
  (`keyToAccepted`) and to the first output the viewer is sent showing
  the prompt (`keyToDrawn`), and from the answer's entry to the write
  that first draws it (`writtenToDrawn`, below 0 when drawn as it
  streams). The output is read from the key on, joined with its
  escapes stripped, so a prompt split across writes or coloured
  mid-word still counts. It is looked at every 5 ms, so `keyToDrawn`
  reads high by up to that plus the soak's own loop lag, erring towards
  failing. `unshown` counts the keys outside a wake never seen drawn,
  which `keyToDrawn` leaves out. The first key after each wake can
  wait on the wake, as one the mesh woke is still loading when it is
  typed, so `afterWake` times those apart and the other two leave them
  out. A key typed within 1 s of a key into another conversation is a
  burst, whoever typed them, so `burst` times those apart too, judged
  with the window bursts, and the steady two leave them out. `bar` says
  whether each holds: `rounds` and `tools` at most 250 ms at the p99
  and 1 s at most, failing too when over 1% of turns are `unpaired`, and
  `keyToAccepted` and `keyToDrawn` judged from `keys`, with
  `keyToDrawn` failing too when over 1% of its keys are `unshown`.
  The whole turn's `paired` is reported beside them, unjudged; the
  bursts are judged from their checkpoints and `burst`. `keys` sets
  each steady key beside plain pi's same one, timed from sending its
  RPC prompt to the same entry the hosted key is timed to, each
  conversation's first key (`first`) apart from the rest (`later`),
  with `hosted`, `plain`, `paired` (hosted less plain, with its
  largest), `drawn` (hosted's key to its first drawing) and
  `drawnPaired` (that drawing less plain pi's key to its entry, plain
  pi having no screen). A later key is held to 200 ms at the p99,
  `hosted` and `drawn`. A first key is held to `paired` and
  `drawnPaired` instead, at most 200 ms at the p99 and 1 s at most,
  failing too when over 1% of first keys are `unpaired`: pi's own
  first prompt can pass 200 ms with no host at all, so an absolute bar
  on it would judge pi, not the host. Plain pi is asked its state
  before its first prompt, as a hosted conversation is open before its
  first key, so neither side's start counts.
- `turnsTimed`: every hosted turn's own times, when its key, prompt
  and answer were, plain pi's beside them and its key's when a viewer
  typed it, with plain pi's own key for the same turn, with how it woke when it was the first key since, whether
  it was in a burst, and what each of its steps cost, so a reading the
  report doesn't make can still be made.
- `staggerMs`: the span the first keys were staggered through.
- `slowSteps`: the 10 rounds or tools that cost most over plain pi's,
  each with its turn, place and times, and under `--profile` where the
  host's time went within it, as `slowKeys` says below.
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
  (an entry's source, a job's id, the journal's trace, the entry a
  compaction keeps from, and the error interactive mode names an aborted
  answer by), and `first` names those before the rest. A conversation
  `--restart-mid` cut is `customsLeftOut`: the host keeps its own records
  of the restart and of the turn it carried on, which plain pi has none
  of, so its messages alone are compared. Under `--real`, each entry is
  compared by its shape alone: its type, who said it, how it stopped,
  its parts and the tools it called.
- `real`, under `--real`: the model, every request it refused with its
  status and the start of what it said, and the tokens each side's
  answers took.
- `restartMid`, under `--restart-mid`: how long the host took to stop
  and its socket to answer, the conversations' states then, the turns
  cut off, and how long after the restart began each was answered.
- `faults`, `hostErrors` and `plainErrors`: what went wrong.
- `plainProcesses`: what one process a conversation costs, measured on
  plain pi. `readyMs` spreads each plain pi's time from its start to
  answering a state request, all started at once before the stagger;
  `pssReadyKb` and `rssReadyKb` what each weighed then, and `pssDoneKb`
  and `rssDoneKb` once its turns were done, from the kernel's rollup of
  its mappings. `unread` counts weighings that found no rollup.

The host draws its screens on the same event loop its engines run on,
and serves every conversation from one process where plain pi runs one
a conversation, so its engine turns hold both; a run of one
conversation, with `--profile`, tells them apart. The host also loads
the fixture's own command extensions.
