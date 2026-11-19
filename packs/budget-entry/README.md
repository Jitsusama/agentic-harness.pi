# Budget Entry

A pack, not an extension. It is loaded into every subagent, reviewers
included, with `pi --extension`, and must never be auto-discovered,
which is why it lives here rather than under `extensions/`.

## What It Is For

A person's session writes the budget it draws on into its log, from
the quest workflow, and spend-watch bills each session's cost to the
budget its log names. A reviewer, like any isolated subagent, starts
with `--no-extensions`, so the quest workflow never runs in it, yet it
inherits its parent's budget and key and spends on them. In one hour, 294 council reviewer logs
named no budget, so what they cost was billed to none.

## How It Works

When the subagent's session starts, the pack reads the budget from
the environment it was started with (`PI_BUDGET`, or none) and appends
the same `budget` entry the quest workflow writes: `{"v":1,"name":...}`,
with a null name for the default. A resumed run whose log already ends
on that budget writes nothing more. A subagent run with no session log
has nowhere to write it, so the pack writes nothing there.
