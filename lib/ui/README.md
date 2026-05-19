# UI Library

TUI component library for Pi extensions. Provides interactive
panels, content rendering and text layout utilities built on
top of Pi's TUI primitives.

## Key Entry Points

### Interactive prompts and views

- **`promptSingle`** — show a single interactive prompt with
  content, options and actions. Returns the user's decision.
- **`promptTabbed`** — show a tabbed prompt where each tab is
  an independent decision.
- **`workspace`** — show a stateful workspace with per-tab
  views and input handlers.
- **`view`** — show read-only scrollable content.

### Content rendering

- **`renderMarkdown`**, **`renderDiff`**, **`renderCode`** —
  render content as themed, syntax-highlighted output.
- **`renderNavigableList`** — render a cursor-navigable list
  with labels and detail columns.

### Compact indicators

- **`renderBadge`** — single-token indicator (themed dot,
  fraction, label) for severity, status and progress.
- **`renderBar`** — visual fraction as a filled/empty
  character bar. Composes inside summaries and status lines.
- **`renderPipelineProgress`** — horizontal or vertical
  multi-stage indicator for any pipeline that marches through
  named stages (council, TDD, plan-workflow, mastery).
- **`renderNarrationLine`** — single-line transcript
  annotation (`※ <prefix>: <body>`) for side-effect actions
  and cross-surface coordination.

### Text layout

- **`contentWrapWidth`**, **`wordWrap`** — text layout
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
