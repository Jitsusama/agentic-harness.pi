# review-judge-format

The output contract for a consolidating judge in a `review_ask judge`
round, loaded into the judge subagent with `--skill`.

The shape is the council's, because a consolidated finding is a finding.
What this adds is `raisedBy`, and the reason it matters: agreement
between reviewers who could not see each other's work is the only
evidence a consolidation can add that was in no single pass.

Read [`SKILL.md`](./SKILL.md) for the contract. The reader it describes
is [`lib/review/ask/harvest.ts`][harvest], called with a judge origin by
[`lib/review/ask/judge.ts`][judge].

Related: [`review-council-format`](../review-council-format) for the
shared finding shape, and [`review-guide`](../review-guide) for driving
the tools.

[harvest]: ../../lib/review/ask/harvest.ts
[judge]: ../../lib/review/ask/judge.ts
