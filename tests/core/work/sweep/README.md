# Sweep Tests

The tests of the sweep that takes back ended sessions' trees
(`lib/core/work/sweep.ts` and the modules beside it), each against a real
repository and real tree records: the trees it takes and keeps, the claims
quests hold on them, the idle snapshots open sessions hold, the worktrees
open sessions left clean and pushed a day, whose branches stay for them
(`sweep-idle-worktree.test.ts`), and the branches origin's trunk already
has. How the sweep chooses which idle snapshots to
judge, and when it stops, is tested against git's answers made up, in
`sweep-idle-choosing.test.ts`. Which trees it asks git's status of, and
how many at once, is in `sweep-status.test.ts`. What they stand on is in `../support/`.
