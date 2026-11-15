# Desktop

The files the quest workflow keeps for the desktop's launcher to read.
The quest index's pass, `keepDesktopListsCurrent` in
`../quest-index.ts`, writes them from one walk of the quests.

- `file.ts`: writing one such file, by a rename so a reader never
  sees half of it, and only when what it says changed.
- `orchestrators.ts`: the list of orchestrators, live or not, in
  `orchestrators.json`.
