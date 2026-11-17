# Quest Library Tests

The tests of `lib/internal/quest`, in the same folders as the library,
each test beside the name of the module it tests:

- `documents/`: a quest file's format: front matter, the document
  reads, parsed files and body edits.
- `discovery/`: the walk across the tree, its memo and what it holds
  back, and which quest a folder belongs to.
- `fields/`: writing a quest's fields, the fields the workflow owns,
  budgets, and reorders and reparents with their journal.
- `workspace/`: a quest's trees, its scratch, what it holds on disk,
  and the git checks the write gate makes.
- `sessions/`: which pi sessions are open, on which quest, alive or
  not, and what each is doing and is told first.
- `reopening/`: putting sessions and their windows back after a
  restart, a boot's end or another machine's.
- `support/`: helpers the discovery tests share.

`discovery-seed.test.ts` stays at the top, beside the module it tests,
which stays at the top of the library. The library's `creation/` has no
tests of its own here yet.
