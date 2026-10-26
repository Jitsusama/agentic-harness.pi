---
name: convention-recurrence-sensor-guide
description: >
  How to measure whether convention corrections keep recurring
  in the pi session logs, by category and by week. Use to record
  a baseline before the convention gates take effect and to
  re-run afterwards to confirm the recurring categories bend
  down. Also how to run the learning sensor, which counts the
  refusals, guard blocks and broken standing rules that recur,
  to pick harness changes and measure them. Pairs with the
  convention gates (pr-guardian,
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

This counts corrections the person typed, the pain the gates remove.
It does not count the gate blocks themselves (those are the gates
working, not the person correcting). A separate rise in gate blocks
with a fall in the person's corrections is the healthy signature: the
gates are absorbing the corrections the person used to type.

## The Learning Sensor

The gate blocks, and the mistakes no gate catches, are what the
learning sensor counts:

```bash
node scripts/learning-sensor.ts [--since YYYY-MM-DD] [--top N] [--json <file>]
```

It writes a markdown report to stdout: the sessions active each
week, then the top groups of each kind with distinct sessions per
week. `--json` also writes every group with a few samples, for
checking a group against what the logs say.

- **Refusals**: a harness tool answered `⊘`. Grouped by the
  refusal's first line, with each bullet under it (a section over
  its limit, say) counted again as a reason.
- **Guards**: a shell command a harness guard blocked. Ordinary
  command failures are left out.
- **Habits**: a tool call that breaks a standing rule, such as a
  tracked file edited with sed, `sleep` to wait or `git stash`.
  Heredoc bodies are cut before matching.

Refusals and guards are exact. Habits are patterns, so check a
group's samples before acting on it. A group that recurs across
many sessions is a candidate harness change: a refusal that
loops wants a better answer or an automatic fix, and a habit
wants a guard or a line in the standing context. Re-run it after
the change lands, and compare that group's sessions per week
against the sessions active, since a short week reads lower.
The harness owner reviews each suggested change.

The weekly measure runs the sensor over the last seven days
beside the `spend` tool's weekly audit, with no pi session, and writes one
report to the state directory's `measure/` folder, named for
the day the week ends:

```bash
node scripts/weekly-measure.ts [--out <file>] [--top N]
```

It is what a weekly timer runs, and what each re-take reads.
