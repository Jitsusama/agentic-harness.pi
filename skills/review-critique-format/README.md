# review-critique-format

The output contract for a critic in a `review_ask critique` round,
loaded into each critique subagent with `--skill`.

A critique records positions, not findings. Keeping the two apart is
what lets a reader see a challenge beside the finding it challenges
instead of mixed into it, and it is why a critic cannot raise anything
of its own.

Two rules in here are load-bearing rather than stylistic. A bare vote is
dropped, because a position nobody can weigh lets a critic move a
finding's standing without making an argument. And silence is no
position, never assent, because reading an absent critique as agreement
would let a critic that ran out of budget manufacture consensus.

Read [`SKILL.md`](./SKILL.md) for the contract. The reader it describes
is [`lib/review/ask/critique.ts`][critique].

Related: [`review-guide`](../review-guide) for driving the tools.

[critique]: ../../lib/review/ask/critique.ts
