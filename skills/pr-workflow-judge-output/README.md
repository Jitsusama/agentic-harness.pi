# PR Workflow Judge Output

Defines the output contract for round-2 judge subagents in the
pr-workflow pipeline: the JSON shape of a consolidated finding,
the attribution fields that trace it back to the council
reviewers, the optional self-signal and the `verify_output`
self-check the judge runs before it returns.

Unlike most skills, this one is not matched to a task. The
pr-workflow extension loads it into the judge subagent through
`--skill`, so the consolidated list arrives in the one shape
the user synthesis and posting steps expect.

Pairs with `pr-workflow-council-output`, whose findings the
judge consumes, and with `pr-workflow-guide` for how the
pipeline fits together.
