# Presence Tests

The tests of `lib/mesh/presence.ts` and of what this session's own peer
publishes through it, one file for each thing a presence says. Each
case keeps the describe it had in the single file these came from, so
a run names the same cases; a reload's effect on a step, a pause or a
move is tested beside that step, pause or move.

| File                    | Tests                                                   |
| ----------------------- | ------------------------------------------------------- |
| `store.test.ts`         | presences kept on disk and read back                    |
| `sweep.test.ts`         | the sweep of files no reader can read, and what it kept |
| `window.test.ts`        | the window title and terminal window the desktop finds  |
| `quest.test.ts`         | what its quest and folder say, and the groups they give |
| `orchestration.test.ts` | its place in an orchestration                           |
| `activity.test.ts`      | what it is doing, and what it waits on its person for   |
| `moves.test.ts`         | what a node needs to move it                            |
| `kept.test.ts`          | the groups, stops and landings it keeps across a reload |
| `trees.test.ts`         | the trees its session holds, named by repository        |
| `subjects.test.ts`      | the subjects it says it works on, owned and declared    |
| `serves.test.ts`        | the needs its quest took, as the node reads them        |
| `lineage.test.ts`       | the cell its quest split from, as the node reads it     |

- `support/`: what they share, this session's id, a peer's presence and
  the surroundings its own peer runs in.
