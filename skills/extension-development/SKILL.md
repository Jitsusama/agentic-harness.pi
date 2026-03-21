---
name: extension-development
description: >
  How to develop Pi extensions. Discovery workflow for TUI
  components, available APIs, composition patterns and common
  mistakes. Use when building or modifying extensions.
---

# Pi Extension Development

## Discovery Workflow

Before building any UI, follow this sequence:

1. **Read Pi's TUI docs** for patterns and available components:
   `/nix/store/hzcf5vfkr9cln378lzy5dfy39jin26p6-pi-coding-agent-0.58.1/lib/node_modules/pi-monorepo/docs/tui.md`

2. **Read the type declarations** for the specific component
   you need. All exports from `@mariozechner/pi-tui`:
   `/nix/store/hzcf5vfkr9cln378lzy5dfy39jin26p6-pi-coding-agent-0.58.1/lib/node_modules/pi-monorepo/packages/tui/dist/index.d.ts`

   Component-specific types live in `dist/components/*.d.ts`
   under that same package directory.

3. **Read the higher-level components** exported by
   `@mariozechner/pi-coding-agent`:
   `/nix/store/hzcf5vfkr9cln378lzy5dfy39jin26p6-pi-coding-agent-0.58.1/lib/node_modules/pi-monorepo/packages/coding-agent/dist/modes/interactive/components/index.d.ts`

4. **Check this project's `extensions/lib/ui/`** for existing
   abstractions built on top of Pi's primitives. Don't
   duplicate what's already there.

5. **Browse Pi's examples** for working implementations:
   `/nix/store/hzcf5vfkr9cln378lzy5dfy39jin26p6-pi-coding-agent-0.58.1/lib/node_modules/pi-monorepo/examples/extensions/`

## What's Available (Orientation Only; Verify Against Source)

**From `@mariozechner/pi-tui`:**

| Need | Component |
|------|-----------|
| Group children vertically | `Container` |
| Padded container with background | `Box` |
| Display text with word wrap | `Text` |
| Display text truncated to width | `TruncatedText` |
| Render markdown | `Markdown` |
| Empty vertical space | `Spacer` |
| Single-line text input | `Input` |
| Multi-line editor with autocomplete | `Editor` |
| Pick from a list | `SelectList` |
| Toggle settings | `SettingsList` |
| Spinner animation | `Loader` |
| Cancellable spinner with AbortSignal | `CancellableLoader` |
| Display an image | `Image` |
| Key detection | `matchesKey`, `Key` |
| Text width / truncation / wrapping | `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi` |
| Fuzzy search | `fuzzyMatch`, `fuzzyFilter` |

**From `@mariozechner/pi-coding-agent`:**

| Need | Component |
|------|-----------|
| Full-width border line | `DynamicBorder` |
| Bordered spinner with cancel | `BorderedLoader` |
| Custom editor with app keybindings | `CustomEditor` |
| Coloured diff output | `renderDiff` |
| Syntax highlighting | `highlightCode`, `getLanguageFromPath` |
| Pre-built themes for components | `getMarkdownTheme`, `getSelectListTheme`, `getEditorTheme`, `getSettingsListTheme` |
| Keybinding hint formatting | `keyHint`, `appKeyHint`, `rawKeyHint` |
| Visual line truncation | `truncateToVisualLines` |

**From `ctx.ui` (ExtensionUIContext):**

| Need | Method |
|------|--------|
| Selection dialog | `select()` |
| Yes/no confirmation | `confirm()` |
| Text input dialog | `input()` |
| Multi-line editor dialog | `editor()` |
| Toast notification | `notify()` |
| Footer status indicator | `setStatus()` |
| Loading message during streaming | `setWorkingMessage()` |
| Persistent widget above/below editor | `setWidget()` |
| Replace footer | `setFooter()` |
| Replace header | `setHeader()` |
| Full custom component | `custom()` |
| Overlay (floating component) | `custom()` with `{ overlay: true }` |
| Replace the input editor | `setEditorComponent()` |
| Manipulate editor text | `setEditorText()`, `getEditorText()`, `pasteToEditor()` |
| Theme access | `theme` property |
| Tool output expansion | `getToolsExpanded()`, `setToolsExpanded()` |
| Terminal title | `setTitle()` |
| Raw terminal input | `onTerminalInput()` |

**From this project's `extensions/lib/ui/`:**

| Need | Module |
|------|--------|
| Bordered scrollable panel with options | `panel.ts` (`showPanel`, `showPanelSeries`) |
| Approval gate with steer option | `gate.ts` (`showGate`, `formatSteer`) |
| Markdown/diff/code rendering | `content-renderer.ts` |
| Word wrap and text helpers | `text.ts` |

## Gotchas

These are design decisions in Pi that aren't obvious from the
type signatures. They'll cause real bugs when you miss them.

### Each Render Line Must Be ≤ Width

`render(width)` must return lines no wider than `width` visible
characters. Use `truncateToWidth()` on every line. ANSI escape
codes don't count toward width, but wide characters (CJK,
emoji) count as 2.

### Always Use Theme from the Callback

Never import `theme` directly. Pi's module caching means the
global `theme` may be undefined in extension code loaded via
jiti. Always grab the `theme` parameter from:
- `ctx.ui.custom((tui, theme, kb, done) => ...)`
- `renderCall(args, theme)`
- `renderResult(result, options, theme)`

### Type the DynamicBorder Colour Parameter

```typescript
// Correct: explicit type annotation
new DynamicBorder((s: string) => theme.fg("accent", s))

// Wrong: jiti inference fails
new DynamicBorder((s) => theme.fg("accent", s))
```

### Call tui.requestRender() After State Changes

The TUI doesn't auto-render. After modifying state in
`handleInput`, call `tui.requestRender()` to trigger a
redraw.

### Implement invalidate() for Theme Changes

When the theme changes, the TUI calls `invalidate()` on all
components. If you've baked theme colours into cached strings
(via `theme.fg()`, `theme.bg()`), you need to rebuild them in
`invalidate()`. See the "Rebuild on Invalidate" pattern in
Pi's `tui.md`.

### Overlay Components Are Disposable

Create fresh instances each time; never reuse a reference
after the overlay closes because the component is disposed
when it closes.

### Propagate Focusable for IME Support

Container components that embed `Input` or `Editor` must
implement the `Focusable` interface and propagate the `focused`
property to the child. Without this, IME candidate windows
(CJK input) show up in the wrong position.

### Text(content, 0, 0) Inside Box

When placing `Text` inside a `Box`, use 0,0 padding on the
`Text`. The `Box` handles padding. Double-padding is a common
mistake.

### Dialogs Support Timeout and Signal

All dialog methods (`select`, `confirm`, `input`) accept an
options object with `timeout` (auto-dismiss with countdown)
and `signal` (AbortSignal for manual dismiss).
