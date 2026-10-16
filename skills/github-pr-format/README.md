# GitHub PR Format

Teaches the agent to write a pull request description for a
person who will not read the code: a TL;DR they can take in
within eight seconds, then the Problem, the Solution and the
Validation, each with a word ceiling.

Activates when creating pull requests, writing PR descriptions
or discussing what makes a good PR.

The structure comes from research on how people read and
remember text, and the ceilings from an experiment on this
repository's own PRs, where writers given looser ones filled
them and wrote descriptions longer than the ones they replaced.
What the study measured, and where its evidence stops, is in
[How the PR Description Format Was Chosen][study].

Only what can be counted or matched exactly is enforced, by the
section gate in `pr-guardian` and by `review_offer`, which takes
the four sections as separate fields and writes the headings
itself. Everything else is judgement, which the skill's Before You
Submit questions carry.

[study]: ../../docs/pr-descriptions.md

Pairs with the [review-integration extension](../../extensions/review-integration/)
for proposing the change and for inline self-review comments.
