# PR Workflow Council Output

Defines the output contract for round-1 council reviewer
subagents in the pr-workflow pipeline: the JSON shape of a
finding, the location kinds, the thread-relation fields and
the `verify_output` self-check each reviewer runs before it
returns.

Unlike most skills, this one is not matched to a task. The
pr-workflow extension loads it into every council reviewer
subagent through `--skill`, so each reviewer answers in the
one shape the judge round can consolidate.

Pairs with `pr-workflow-judge-output`, which defines the shape
the judge produces from these findings, and with
`pr-workflow-guide` for how the pipeline fits together.
