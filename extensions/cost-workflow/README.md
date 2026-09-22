# Cost Workflow

The one place in this package that reasons about money.

## Why It Reads Logs Instead of Recording Cost

Cost used to be counted by whoever needed it, which produced five wrong
answers in a row: fan-out spend undercounted two to threefold from a
parent tool result, compaction cost missed entirely because its usage
sits at the top level of its entry rather than under `message`, and a
corpus-wide total silently cut to a tenth of the truth by a shell
pipeline that stopped at the first unreadable line.

Deriving everything from the logs pi already writes gives one writer of
the truth and a ledger that can be thrown away and rebuilt whenever its
shape changes. Nothing here is a second record that can drift from the
first.

## What It Answers

The `cost` tool reports the overall total, or spend grouped by repo,
quest, model, day, session or kind. Each slice carries its turn count and
its cost per turn, which is the figure worth watching: cost per turn is
97 percent explained by the context resident when a turn runs, and it
varies more than fivefold between subjects.

## Coverage Is Part of Every Answer

An aggregate that cannot say what it missed is not evidence, so:

- Turns that carried no usage are counted but never priced at zero. A
  turn whose provider died cost an unknown amount, and pricing it as free
  cannot be told apart from a turn that was genuinely free.
- Spend whose session named no repo or quest stays a visible slice with
  its share named, rather than being dropped by an inner join. Only a
  quarter of logs name a quest, so hiding the remainder would make every
  quest's share a fraction of a total that excluded most of the money.
- Unreadable lines are counted and reported, never fatal.

## Indexing

Session logs are append-only, so a log whose byte length has not changed
since the last pass is not read again. A routine pass costs seconds; a
full corpus of 1,167,000 lines takes about 80 seconds.

Logs are streamed a line at a time rather than read whole. The largest
log here is 1.2 GB, past the ceiling on a JavaScript string, so anything
reading a file in one piece cannot open it at all.

## Files

- `index.ts`: registration, store lifecycle and the `cost` tool.
- `indexer.ts`: walking pi's session directories incrementally.
- `report.ts`: pure formatting, tested without loading pi.

The store, the turn and session types and `repoOf` live in
`agentic-harness.core`'s `observability` module, since a billable turn is
not a pi-specific idea. Reading pi's log format is, which is why the scan
is the piece that belongs here; it currently still sits upstream and
moving it is recorded as follow-up.
