# PR Workflow Critique Output

Defines the output contract for round-3 critique reviewer
subagents in the pr-workflow pipeline: the JSON shape of a
critique entry, the position vocabulary a reviewer may take on
the judge's consolidated list, the rationale each entry
requires and the `verify_output` self-check before it returns.

Unlike most skills, this one is not matched to a task. The
pr-workflow extension loads it into each critique reviewer
subagent through `--skill`, so the round-3 pushback arrives in
the one shape the round-4 view can render.

Pairs with `pr-workflow-judge-output`, whose consolidated
findings the critique round challenges, and with
`pr-workflow-guide` for how the pipeline fits together.
