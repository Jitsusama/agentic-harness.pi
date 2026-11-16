# Review Integration Tests

The tests of `../../../extensions/review-integration/`. What the tools
read, say, draft and attach sits at the top; three kinds of work have a
folder each:

- `rounds/`: asking models to review a change through `review_ask`: the
  roster and what each reviewer runs with, a round's panel, job and
  record, and collecting a round nobody lived to finish.
- `gates/`: the write gates a person approves before anything leaves:
  how each is drawn and fits its panel, what a decision or a redirect
  hands back, and the guard policy over them.
- `offer/`: putting a change up and moving it along through
  `review_offer`: proposing, stacks, sections, the merge guard, merge
  gates and the queue.
