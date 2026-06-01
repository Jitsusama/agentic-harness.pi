---
name: convention-recurrence-sensor-guide
description: >
  How to measure whether convention corrections keep recurring
  in the pi session logs, by category and by week. Use to record
  a baseline before the convention gates take effect and to
  re-run afterwards to confirm the recurring categories bend
  down. Pairs with the convention gates (pr-guardian,
  issue-guardian, commit-guardian, slack-integration) and the
  convention-context extension.
---

# Convention Recurrence Sensor

The convention gates exist to stop the same correction being
typed twice. This sensor measures whether they work: it counts
how often a convention correction recurs in the session logs, by
category and by week, so a recurring category that bends down
after the gates ship is the evidence the fix landed.

The same query that diagnosed the problem is the sensor that
tracks the fix. There is no separate instrumentation to trust.

## Running It

```bash
node scripts/convention-recurrence.ts [--since YYYY-MM-DD]
```

Node strips the TypeScript types and runs the file directly; no
build step is involved. A `MODULE_TYPELESS_PACKAGE_JSON` warning
on stderr is benign, the output is on stdout. `--since` limits
the scan to logs on or after a date.

The output is a tab-separated table, one row per ISO week, one
column per category. Each cell is the number of distinct
sessions that quarter a correction in that category that week,
so a single ranty session counts once, not ten times. Distinct
sessions per week is the right grain for "does this keep coming
back".

## The Categories

The classifier looks for the strong correction signals, not
every phrasing. It favours precision over recall: a trend that
bends is the goal, not a precise census.

- **emdash**: a complaint about emdashes, or the character or its
  escape appearing in a correction.
- **spelling**: a Canadian-versus-American or British spelling
  correction.
- **sections**: a rebuke about inventing or adding sections to a
  PR or issue body.
- **slack-format**: a correction about pipe tables, malformed
  lists or image embeds in Slack.
- **commit**: a correction about conventional-commit shape or
  imperative mood.

The patterns live in `scripts/convention-recurrence.ts` and are
exercised by `tests/scripts/convention-recurrence.test.ts`. Tune
them there if a real correction is being missed; keep precision
high so the trend stays meaningful.

## Recorded Baseline

Captured 2026-05-31, scanning from 2026-04-01, before the
convention gates and the resident block had any effect. Distinct
sessions per week:

| Week     | emdash | spelling | sections | slack-format | commit |
|----------|--------|----------|----------|--------------|--------|
| 2026-W14 | 13     | 0        | 0        | 0            | 0      |
| 2026-W15 | 5      | 0        | 0        | 0            | 0      |
| 2026-W16 | 11     | 1        | 0        | 0            | 0      |
| 2026-W17 | 3      | 2        | 1        | 0            | 1      |
| 2026-W18 | 5      | 0        | 0        | 1            | 1      |
| 2026-W19 | 3      | 1        | 1        | 2            | 1      |
| 2026-W20 | 2      | 0        | 6        | 0            | 1      |
| 2026-W21 | 7      | 1        | 6        | 1            | 4      |
| 2026-W22 | 6      | 0        | 2        | 0            | 3      |

emdash recurs every single week, sections spike in the closing
weeks, and spelling, slack-format and commit recur
intermittently. These are the curves to watch. Re-run a few
weeks after the gates have been active and compare: the
convention categories should bend toward zero as the gates catch
violations before they reach a correction.

## What It Does Not Measure

This counts corrections the user typed, the pain the gates remove.
It does not count the gate blocks themselves (those are the gates
working, not the user correcting). A separate rise in gate blocks
with a fall in user corrections is the healthy signature: the
gates are absorbing the corrections the user used to type.
