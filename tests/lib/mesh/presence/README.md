# Presence Tests

The tests of `lib/mesh/presence.ts` and of what this session's own peer
publishes through it, one file for each thing a presence says:

| File                    | Tests                                                   |
| ----------------------- | ------------------------------------------------------- |
| `store.test.ts`         | presences kept on disk and read back                    |
| `window.test.ts`        | the window title and terminal window the desktop finds  |
| `quest.test.ts`         | what its quest and folder say, and the groups they give |
| `orchestration.test.ts` | its place in an orchestration                           |
| `activity.test.ts`      | what it is doing, and what it waits on its person for   |
| `moves.test.ts`         | what a node needs to move it                            |
| `kept.test.ts`          | what it keeps across a reload                           |

- `support/`: what they share, this session's id, a peer's presence and
  the surroundings its own peer runs in.
