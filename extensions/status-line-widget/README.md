# Status Line Extension

pi's one line along the bottom, in the language of a shell prompt: where
pi is working, told from its root, and the branch at the right with its
marks. Each field shows only while it's true, and they give way a step at a
time as the terminal narrows.

## Layout

```
dotfiles/modules/neovim  rebase ◆◈◇  claude-opus-5-5 high     ⚑  ◑ 45.2k ∂ $0.04 Σ $1.23  main *
└──────────────────────── left ─────────────────────────┘     └──────────── right ─────────────┘
```

Fields are two spaces apart and a mark sits one space from its words, so
each reads with its own.

**Left:**

- Where pi is working, told from the nearest root: the root's name in
  text, the folders between muted, the folder itself strong. Outside a
  root it is told from home as `~`, and outside home from `/`, muted.
- What git is in the middle of: a rebase drawn as its steps (a count past
  eight), a merge, pick, revert or bisect by name, the step under way in
  the warning colour, or the alert's while a conflict waits.
- The model, muted, with how hard it thinks: the thinking mark in its
  level's colour, then the level's word. Nothing while thinking is off.

**Right:**

- Each extension's status, whole.
- The panel's height, only while it isn't the usual one.
- Context, marginal cost and session total, as one meter.
- The branch, muted, with a mark for commits not yet pushed. Work not
  yet committed has no mark.

A field that gives way goes without a trace. A mark saying only that
something is missing would be one more to learn, and a wider window shows
the field again.

## Where It Learns the Folder and Git

A machine whose prompt tells folders and git can write `where.json` into
`~/.config/pi/agentic-harness.pi/status-line/` (under `XDG_CONFIG_HOME`
when it is set), so the two agree:

```json
{
  "engine": "/path/to/gitstatusd",
  "roots": ["zone.nix", ".git"],
  "marks": { "branch": "\uf418", "unpushed": "\uf431" }
}
```

- `engine` answers git's state in gitstatusd's protocol. It is started the
  first time it's needed and kept, and asked again only when something may
  have changed the answer: the session starting, a tool finishing, a shell
  command, the agent settling, pi seeing the branch move. Nothing polls.
  A program that can't start, or ends before it answers, isn't started
  again.
- `roots` are the files or folders that mark a root; the nearest folder
  holding any of them names it.
- `marks` are drawn by meaning: `branch`, `unpushed`, `more`,
  `complete`, `active`, `pending` and `thinking`. A mark left out takes the
  package's own, an empty one draws the words alone, and one the line
  doesn't draw, such as a prompt's `unsaved`, is left unread.

Without the file a folder is told from the nearest `.git`, and the branch
is pi's own, with no marks.

## What an Extension Puts Here

The line never shortens an extension's status: it goes in whole, or
the line falls back to the folder's name. So each status costs the
columns it asks for, on a line every extension shares.

A status here is therefore a mark, from the one table in
`lib/ui/footer-mark.ts`: a glyph in the colour of how much it wants
you, and a quiet number beside it only when the number tells you
something. It shows only while its state holds, and its detail is one
step away in the command that owns it. Words never go here, and text
never carries the colour.

| Mark | Says | Detail |
| ---- | ---- | ------ |
| `⚑`, muted | guard modes are overridden this session | `/guards` |
| `☾`, muted, or warning with a count | away; the count is calls held for your return | listed when you come back |
| `⧗`, muted | background work is running | `/jobs` |
| `✕`, error, with attempts | verification fails | the verify tool |

A quest says nothing here: its kind and status glyphs lead its own
line above the editor, and its id ends that line. A subagent fleet says nothing here either,
since its board is docked for as long as a summary would show.

## Degradation Order

As the terminal narrows, each step is taken in turn, keeping the ones
before, until the line fits:

1. The session total goes.
2. The branch keeps its start and end, the more mark between.
3. The folders between the root and the folder become the more mark.
4. Context in tokens becomes a share (`45.2k` to `23%`).
5. The model takes its short name (`claude-sonnet-4-20250514` to
   `sonnet-4`).
6. How hard it thinks goes.
7. The branch goes to its mark, keeping the marks after it.
8. What git is in the middle of goes to its mark.
9. The path goes to the folder's name.
10. The model goes.
11. The folder's name keeps its start and end.

The rate is never given up: it is the one reading here that changes what
to do next. When nothing else fits, the folder's name is all that's left.
