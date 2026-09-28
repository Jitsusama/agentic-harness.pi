# UI Library

TUI component library for Pi extensions. Provides interactive
panels, content rendering and text layout utilities built on
top of Pi's TUI primitives.

## Key Entry Points

### Interactive prompts and views

- **`promptSingle`**: show a single interactive prompt with
  content, options and actions. Returns the user's decision.
- **`promptTabbed`**: show a tabbed prompt where each tab is
  an independent decision. It writes progress through the
  batch to the session status line while it is open and
  clears it on the way out, so a caller neither has to set it
  nor can forget to clear it.
- **`workspace`**: show a stateful workspace with per-tab
  views and input handlers.
- **`view`**: show read-only scrollable content. Pass a
  `signal` to dismiss it from code.
- **`runGate`**: hold work that shows a panel until whatever
  is already on screen has finished. Pi mounts one component
  at a time, so two panels raised in the same turn otherwise
  race: the first takes the screen and the rest either hang or
  pass unseen, and a gate nobody saw still counts as approval.
  Every primitive above already mounts through this queue, so
  a caller only needs it to keep several prompts together as
  one turn on screen; a prompt asked for inside that turn runs
  at once rather than queueing behind it. The queue is
  process-global, so two packages carrying their own copy of
  this library still share one. Pass a `signal` to leave the
  queue while waiting (the call rejects with an `AbortError`
  and nothing mounts); the primitives pass the turn's signal
  themselves and answer a withdrawn gate the way Escape would,
  so it fails closed. The holder's `release()` hands the
  screen on early, for a panel that left without settling.

Every prompt and view comes off the screen by its own overlay
handle, never by hiding whatever overlay happens to be on top,
so answering one under another program's panel leaves that
panel alone. Each also closes when its turn is stopped
(interrupt, `/new`, a session switch) and answers the way
Escape would, so a gate fails closed and nothing waits on a
key after its turn is gone. A panel raised outside a turn
closes the same way when its session ends, whether it is up or
still waiting: the panel registry records each one, and
`panel-lifecycle-workflow` closes them all on
`session_shutdown`, across every copy of this library.

### Content rendering

- **`renderMarkdown`**, **`renderDiff`**, **`renderCode`**:
  render content as themed, syntax-highlighted output.
- **`renderNavigableList`**: render a cursor-navigable list
  with labels and detail columns.

### Compact indicators

- **`renderBadge`**: single-token indicator (themed dot,
  fraction, label) for severity, status and progress.
- **`renderBar`**: visual fraction as a filled/empty
  character bar. Composes inside summaries and status lines.
- **`renderPipelineProgress`**: horizontal or vertical
  multi-stage indicator for any pipeline that marches through
  named stages (council, TDD, quest-workflow, mastery).
- **`renderNarrationLine`**: single-line transcript
  annotation (`※ <prefix>: <body>`) for side-effect actions
  and cross-surface coordination.

### What the panels tell you about themselves

Both prompts scroll, vertically and horizontally, keeping an
offset per tab and per view. The footer says so, through
`needsVScroll` and `needsHScroll`, and only when the content
actually overflows: a hint that is always on is chrome, and
chrome is what people stop reading. Without those hints,
content that scrolls is indistinguishable from content that
was cut off, which is what they looked like for a long time.

Progress through a batch is a session-level fact, so it goes
on the status line rather than inside the tab strip. The
strip spends its whole width on tabs. It used to reserve
thirteen columns for a bar plus four for the gap, which is
what pushed tabs into an ellipsis on panels that had room
for all of them.

### Text layout

- **`contentWrapWidth`**, **`wordWrap`**: text layout
  utilities for panel content.

Import from the barrel:

```typescript
import { promptSingle, renderMarkdown } from "agentic-harness.pi/ui";
import { renderBadge, renderBar } from "agentic-harness.pi/ui";
import { renderPipelineProgress } from "agentic-harness.pi/ui";
import { renderNarrationLine } from "agentic-harness.pi/ui";
```

## Composition patterns

The compact indicators are designed to compose. A finding
row in a navigable list typically looks like:

```typescript
const summary =
  `${renderBadge("critical", theme)} ` +
  `${index}. ${label}` +
  ` ${renderBar(agreement, total, theme, { hideFraction: true })}` +
  ` ${theme.fg("dim", location)}`;
```

A council progress line tucked into a status fragment:

```typescript
const line = renderPipelineProgress(stages, theme);
ctx.ui.setStatus("council", line);
```

A narration line announcing a side-action from another
surface:

```typescript
const text = renderNarrationLine("nvim", "endorsed finding 3", theme);
pi.sendMessage({ customType: "narration", content: text, display: true });
```
