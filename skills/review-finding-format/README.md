# review-finding-format

The shape of one finding, shared by every `review_ask` round that
answers with findings: council, judge and stack. It is loaded with
`--skill` beside the round's own contract, which says what wraps the
findings and what each round adds.

It is a skill of its own because a judge sent to the council's
contract for the shape read it and still answered with fields of its
own (`category`, a top-level `file` and `line`, a label word in
`severity`), so that round's findings were read as notes on the change.
Named as the judge's own contract, the shape is no longer another
round's concern. Whether that alone stops the drift is not yet shown;
the reader keeps what a drifted finding says either way.

Read [`SKILL.md`](./SKILL.md) for the shape itself. The reader it
describes is [`lib/core/review/ask/harvest.ts`][harvest]; if the two ever
disagree, the reader wins and this file is the bug.

Related: [`review-council-format`](../review-council-format),
[`review-judge-format`](../review-judge-format) and
[`review-stack-format`](../review-stack-format), the rounds that load
it, and [`review-guide`](../review-guide) for driving the tools.

[harvest]: ../../lib/core/review/ask/harvest.ts
