# Claude Plan Widget

Where a Claude plan's allowances stand, on the footer, while the session
reaches Claude through Claude Code on that plan
([earendil-works/pi-claude-code][pcc]). The mark is the spark Claude
Code draws for itself.

```
✻ 5h 12% wk 3%
```

A plan has two windows, five hours and a week, and a turn past either
stops until it resets. The mark is dim while both have room, turns to the
warning colour once either passes 80% and says when that window starts
again, and to the error colour once Anthropic refuses a turn:

```
✻ 5h 84% until 21:30 wk 20%
```

It reads what the provider puts on each assistant message (the
`claude-code.rate-limit` diagnostic), so a reloaded or resumed session
shows where it stood before its next turn. Under any other provider the
footer says nothing of it. The parsing lives in
[`lib/internal/claude-plan.ts`](../../lib/internal/claude-plan.ts).

[pcc]: https://github.com/earendil-works/pi-claude-code
