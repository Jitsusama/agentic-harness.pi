# review-stack-format

The output contract for a reviewer in a `review_ask stack` round, loaded
into each subagent with `--skill`.

The council shape plus `refs`, naming the changes a finding is about.
That one field is the whole point of the round: without it a reviewer
reports everything against whichever change it happened to be reading,
and a cross-change finding becomes several unrelated ones.

Refs rather than positions, because a stack renumbers itself whenever
anybody restacks it, so a finding recorded as "the second change" is
about something else the moment anything lands underneath.

Read [`SKILL.md`](./SKILL.md) for the contract. The reader it describes
is [`lib/review/ask/span.ts`][span], and the round is
[`lib/review/ask/stack-round.ts`][round].

Related: [`review-council-format`](../review-council-format) for the
shared finding shape, and [`review-guide`](../review-guide) for driving
the tools.

[span]: ../../lib/review/ask/span.ts
[round]: ../../lib/review/ask/stack-round.ts
