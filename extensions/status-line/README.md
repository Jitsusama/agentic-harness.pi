# Status Line Extension

Responsive single-line footer that adapts to terminal width.

## Layout

```
~/src/project (main) │ sonnet-4       🧠³ │ 45.2k/200k │ $0.123 │ ⏸ planning
└──── left side ────┘                 └──────── right side (right-justified) ───┘
```

**Right side** (right-justified):
- Extension statuses (plan-mode, tdd-mode indicators)
- Thinking level glyph (🧠¹ minimal → 🧠⁵ xhigh)
- Context token usage (absolute or percentage)
- Session cost

**Left side:**
- Directory (with git branch)
- Model name

## Degradation Order

As the terminal narrows, detail is removed in this order:

1. Shrink directory (full path → basename)
2. Remove cost
3. Context tokens → percentage (e.g. `45.2k/200k` → `23%`)
4. Shrink model name (e.g. `claude-sonnet-4-20250514` → `sonnet-4`)
5. Remove thinking glyph
6. Remove branch

The directory basename is never removed.
