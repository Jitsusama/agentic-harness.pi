# review-council-format

The output contract for a discovery reviewer in a `review_ask council`
round, loaded into the reviewer subagent with `--skill`.

The contract lives in a skill rather than in the prompt because a
contract stated in two places drifts, and the copy in the prompt is the
one nobody updates. The prompt owes the reviewer the material: the
change, its diff, and where an anchor can legitimately land. This owes
it the shape.

Read [`SKILL.md`](./SKILL.md) for the contract itself. The reader it
describes is [`lib/review/ask/harvest.ts`][harvest]; if the two ever
disagree, the reader wins and this file is the bug.

Related: [`review-judge-format`](../review-judge-format),
[`review-critique-format`](../review-critique-format),
[`review-audit-format`](../review-audit-format) and
[`review-stack-format`](../review-stack-format) for the other rounds,
and [`review-guide`](../review-guide) for driving the tools.

[harvest]: ../../lib/review/ask/harvest.ts
