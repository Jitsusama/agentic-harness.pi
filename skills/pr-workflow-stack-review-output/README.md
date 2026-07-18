# PR Workflow Stack-Review Output

Defines the output contract for stack-wide reviewer subagents
in the pr-workflow pipeline: the JSON shape carrying per-PR
findings under a `perPr` key alongside cross-PR findings, the
key rules that map a finding to its PR, the span fields a
cross-PR finding needs and the `verify_output` self-check
before it returns.

Unlike most skills, this one is not matched to a task. The
pr-workflow extension loads it into each stack-review reviewer
subagent through `--skill` during a stack-aware review, so one
fan-out can speak to a whole stack at once.

Pairs with `pr-workflow-stack-judge-output`, which consolidates
these findings, and with `pr-workflow-guide` for how the stack
review fits together.
