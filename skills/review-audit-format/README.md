# review-audit-format

The output contract for an auditor in a `review_ask audit` round, loaded
into the auditor subagent with `--skill`.

An audit is the one round that looks outward: which threads already on
the change are answered by what the change now does. It never posts and
raises no findings, because these are other people's words and turning
them into findings would put them into the review as ours.

The `elsewhere` standing is the part worth knowing. In a stack a thread
on one change is routinely answered by a sibling, and reporting that as
addressed sends whoever replies looking in the wrong diff.

Read [`SKILL.md`](./SKILL.md) for the contract. The reader it describes
is [`lib/review/ask/audit.ts`][audit].

Related: [`review-guide`](../review-guide) for driving the tools, and
[`comment-format`](../comment-format) for the reply an audit informs.

[audit]: ../../lib/review/ask/audit.ts
