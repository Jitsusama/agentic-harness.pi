# Quest Library

Everything behind the quest tool that isn't the tool itself, grouped by
what changes together:

- `documents/`: a quest file's format, read and edited: front matter,
  the README's projections, body edits, and the Journey.
- `creation/`: making a quest: its id, its first body, and what a URL
  seeds it with.
- `discovery/`: finding quests across the tree: the walk, its memo, who
  mentions whom, which quest a folder belongs to, and the table of
  contents.
- `fields/`: changing a quest's fields: the one journalled way to write
  them, reorders and reparents, the fields the workflow owns, the event
  said when a quest or document is concluded or retired, and what a
  quest takes from those above it.
- `workspace/`: where a quest's work sits on disk: its trees, its
  scratch here and elsewhere, what it holds, and the git checks the write
  gate makes.
- `sessions/`: which pi sessions are open, on which quest, alive or not,
  and what each is doing and is told first.
- `reopening/`: putting sessions and their windows back after a restart,
  a boot's end or another machine's.

Five files stay at the top. `io.ts` (atomic writes and the quest lock),
`dates.ts` and `status.ts` serve most of the folders. `lock-folder.ts`
names the quest lock folder in the login's runtime folder and judges
it, for the lock and for the fence, which binds it through. `discovery-seed.ts`
stays because it keys its seed on a hash of every module under its own
folder, so a change to the parser anywhere here drops the seed.
