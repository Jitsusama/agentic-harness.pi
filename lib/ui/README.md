# UI Library

TUI component library for Pi extensions. Provides interactive
panels, content rendering and text layout utilities built on
top of Pi's TUI primitives.

## Key Entry Points

- **`promptSingle`** — show a single interactive prompt with
  content, options and actions. Returns the user's decision.
- **`promptTabbed`** — show a tabbed prompt where each tab is
  an independent decision.
- **`workspace`** — show a stateful workspace with per-tab
  views and input handlers.
- **`view`** — show read-only scrollable content.
- **`renderMarkdown`**, **`renderDiff`**, **`renderCode`** —
  render content as themed, syntax-highlighted output.
- **`renderNavigableList`** — render a cursor-navigable list
  with labels and detail columns.
- **`contentWrapWidth`**, **`wordWrap`** — text layout
  utilities for panel content.

Import from the barrel:

```typescript
import { promptSingle, renderMarkdown } from "agentic-harness.pi/ui";
```
