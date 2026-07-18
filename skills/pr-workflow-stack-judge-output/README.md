# PR Workflow Stack-Judge Output

Defines the output contract for stack-wide judge subagents in
the pr-workflow pipeline: the JSON shape carrying both per-PR
and cross-PR findings, the attribution fields, the optional
self-signal, the membership rules that decide which PR a
finding belongs to and the `verify_output` self-check before
it returns.

Unlike most skills, this one is not matched to a task. The
pr-workflow extension loads it into the stack-judge subagent
through `--skill` during a stack-aware review, so the
consolidated findings arrive keyed to the right PR in the
stack.

Pairs with `pr-workflow-stack-review-output`, whose findings
the stack-judge consolidates, and with `pr-workflow-guide` for
how the stack review fits together.
