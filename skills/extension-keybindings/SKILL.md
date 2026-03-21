---
name: extension-keybindings
description: >
  Keybinding system for Pi extensions. Rules, verb set, footer
  layout and conventions for panels, gates and interactive
  prompts. Use when writing or modifying extensions that have
  user-facing UI.
---

# Extension Keybindings

Every panel, gate and interactive prompt in the extension
system follows the same input model. This skill defines what
that model is so new work stays consistent with the existing
codebase.

## The Five Rules

1. **No global keyboard shortcuts.** Features are accessed
   through slash commands only. The only exceptions are
   `Ctrl+Alt+F` and `Ctrl+Alt+M` for panel height toggling,
   which must work during panel display.

2. **Numbers for views, letters for actions.** View switching
   keys (`1`, `2`, `3`) and action keys (`a`, `r`, `p`) live
   in structurally separate namespaces. Collisions are
   impossible.

3. **Enter/Escape for binary safe choices.** When a panel has
   one obvious forward action and one obvious cancel, use
   Enter and Escape. Zero letters to memorise.

4. **Explicit letter for destructive or consequential
   actions.** Speed bumps prevent accidents. Delete is `d`,
   not Enter.

5. **Shift = "same thing, but let me talk first."** Every
   action key has a Shift variant that opens an editor before
   executing. `Shift+Escape` is the universal redirect: "none
   of the above, here's what I want instead."

## The Universal Input Model

Every panel follows this model:

| Input | Meaning |
|---|---|
| Action key | Execute immediately |
| Shift + action key | Open editor, then execute with note |
| Enter | Proceed (safe forward action) |
| Shift+Enter | Proceed with guidance |
| Escape | Cancel silently |
| Shift+Escape | Open editor for redirect |
| `1` `2` `3` | Switch view within current tab |

## The Verb Set

Six verbs cover every interaction across all extensions:

| Verb | Key | When to Use |
|---|---|---|
| Approve | `a` | Accept, let through, mark as good |
| Reject | `r` | Refuse, send back |
| Pass | `p` | Reviewed, moving on (tab or thread) |
| Reply | `r` | Respond (where Reject isn't present) |
| New | `n` | Create a new item |
| Delete | `d` | Permanently remove (destructive) |

Don't invent new verbs. If an action doesn't map to one of
these six, reconsider the design.

## The Shift Modifier Contract

Every action key has a Shift variant that opens the note
editor. This is handled by `handleActionInput` in
`action-bar.ts`; extensions don't implement it themselves.

`Shift+Escape` is the universal redirect. It lets the user
say "none of the above" and type guidance. The infrastructure
handles this too.

## View Numbering

Views within a tab use `1`, `2`, `3` as keys. Never letters.
The `formatViewHint` function uses prefix format for number
keys (renders as `[1] Overview`). New views follow sequential
numbering within their tab.

## The Footer Grid

The unified footer (`renderFooter` in `panel-layout.ts`)
adapts to context. When actions are present, it renders two
rows. When they're not, one row.

```
 ┌── actions ───┐                      ┌── modifiers ──┐
 [A]pprove  [R]eject  [P]ass           ⇧+key annotate · ⇧+Esc redirect
 [1] Overview  [2] Source · Tab · C+#  Enter · C+Enter submit · Esc cancel
 └── navigation ┘                      └── decisions ──┘
```

Top-left: what you do to the current item (actions).
Top-right: how to add a note to what you do (modifiers).
Bottom-left: how to move around (navigation).
Bottom-right: how to finish (decisions).

Binary gates with no actions show only the bottom row:

```
                                       Enter proceed · Esc cancel
```

## Adding a New Gate

1. Decide if it's binary (Enter/Escape) or consequential
   (letter keys).
2. Pick verbs from the verb set above.
3. Use `renderFooter` for the hint display.
4. Never invent new verbs without updating this skill.

## Adding a New Workspace

1. Number the views sequentially (`1`, `2`, `3`).
2. Pick action keys from the verb set.
3. Use Pass (`p`) for tab completion.
4. Use `renderFooter` for the hint display.

## What Not to Do

- No global shortcuts. Use slash commands.
- No letter keys for views. Use numbers.
- No Cancel as a letter action. Always Escape.
- No `+` key. Use `n` for New.
- No context-specific verb synonyms (Skip, sKip, Allow,
  Block, Handled, Done, etc.).
- No `registerShortcut` calls except for panel height.
