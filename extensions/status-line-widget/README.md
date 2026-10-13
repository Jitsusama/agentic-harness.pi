# Status Line Extension

A responsive single-line footer that adapts to terminal width.

## Layout

```
~/src/project · main │ opus-5-5     ⚑ │ ⧗ 2 │ ◑ 45.2k/200k ∂ $0.04 Σ $1.23 │ 🧠³
└───── left side ─────────────┘      └───────── right side (right-justified) ─────┘
```

**Right side** (right-justified):
- Extension statuses, each a mark while its state holds
- The panel height glyph
- Context, marginal cost and session total, as one meter
- Thinking level glyph (🧠¹ minimal → 🧠⁵ xhigh)

**Left side:**
- Directory (with git branch)
- Model name

## What an Extension Puts Here

The line never shortens an extension's status: it goes in whole, or
the line falls back to the directory name. So each status costs the
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
| `⧗`, muted | background jobs are running | `/jobs` |
| `✕`, error, with attempts | verification fails | the verify tool |

A quest says nothing here: its kind and status glyphs lead its own
line above the editor, and its id ends that line. A subagent fleet says nothing here either,
since its board is docked for as long as a summary would show.

## Degradation Order

As the terminal gets narrower, detail is removed in this order:

1. Shrink directory (full path → basename)
2. Remove the session total
3. Context tokens → percentage (e.g., `45.2k/200k` → `23%`)
4. Shrink model name (e.g., `claude-sonnet-4-20250514` →
   `sonnet-4`)
5. Remove thinking glyph
6. Remove branch

The marginal rate is never removed, and the directory basename is
never removed.
