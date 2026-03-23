---
name: extension-keybinding-guide
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
   keys (`1`, `2`, `3`) and action keys (`r`, `p`, `w`) live
   in structurally separate namespaces. Collisions are
   impossible.

3. **Enter/Escape for the primary decision pair.** Enter is
   always the default forward action (approve, proceed,
   confirm). Escape is always cancel/dismiss. Zero letters
   to memorise for the most common interaction.

4. **Explicit letter for destructive or consequential
   actions.** Speed bumps prevent accidents. Delete is `d`,
   not Enter. Enter must never trigger a destructive action.

5. **Shift = "same thing, but let me talk first."** Every
   action key has a Shift variant that opens an editor before
   executing. `Shift+Enter` opens the editor then proceeds.
   `Shift+Escape` is the universal redirect: "none of the
   above, here's what I want instead."

## The Universal Input Model

Every panel follows this model:

| Input | Meaning |
|---|---|
| Enter | Approve / proceed (default forward action) |
| Shift+Enter | Proceed with guidance (opens editor first) |
| Escape | Cancel silently |
| Shift+Escape | Open editor for redirect |
| Action key | Execute alternative action immediately |
| Shift + action key | Open editor, then execute with note |
| `1` `2` `3` | Switch view within current tab |

## The Verb Set

Enter and Escape handle the primary approve/cancel pair. Six
letter keys cover every alternative beyond that binary:

| Verb | Key | When to Use |
|---|---|---|
| **R**eject | `r` | Refuse, send back |
| **W**rite | `w` | Compose a response |
| **P**ass | `p` | Reviewed, moving on (tab or thread) |
| **N**ew | `n` | Create a new item |
| **D**elete | `d` | Permanently remove (destructive) |
| **E**xplore | `e` | Go deeper before deciding |

Enter is always the default forward action. Letter keys are
for alternatives beyond approve/cancel. Every key is the
first letter of its verb. No overloading.

## The Shift Modifier Contract

Every action key has a Shift variant that opens the note
editor. This is handled by `handleActionInput` in
`action-bar.ts`; extensions don't implement it themselves.

`Shift+Enter` opens the editor then fires the Enter action
with a note. This is handled in `prompt-single.ts` and
`prompt-tabbed.ts`.

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
rows. When they aren't, one row.

```
 ┌── actions ───┐                      ┌── modifiers ──┐
 [R]eject  [P]ass                       ⇧+key annotate · ⇧+Esc redirect
 [1] Overview  [2] Source · Tab · C+#  Enter approve · C+Enter submit · Esc cancel
 └── navigation ┘                      └── decisions ──┘
```

Top-left: what you do to the current item (actions).
Top-right: how to add a note to what you do (modifiers).
Bottom-left: how to move around (navigation).
Bottom-right: how to finish (decisions).

Binary gates with no actions show only the bottom row:

```
                                       Enter approve · Esc cancel
```

## Adding a New Gate

1. Start with Enter/Escape. Most gates are binary: one
   forward action and one cancel. No letter keys needed.
2. Add letter keys only when there are alternatives beyond
   the binary. Pick verbs from the verb set above.
3. Never use a letter key for the primary forward action.
   That's what Enter is for.
4. Destructive actions always need an explicit letter key.
   Enter must not trigger deletion.
5. Use `renderFooter` for the hint display.
6. Never invent new verbs without updating this skill.

## Adding a New Workspace

1. Number the views sequentially (`1`, `2`, `3`).
2. Enter is the item-level default forward action. Use it
   for approve, confirm or open (depending on context).
3. Pick alternative action keys from the verb set.
4. Use Pass (`p`) for tab completion.
5. Escape is panel-level dismiss, never item-level.
6. Use `renderFooter` for the hint display.

## What Not to Do

- No global shortcuts. Use slash commands.
- No letter keys for views. Use numbers.
- No Cancel as a letter action. Always Escape.
- No letter key for the primary forward action. Always Enter.
- No `+` key. Use `n` for New.
- No context-specific verb synonyms (Skip, Allow, Block,
  Handled, Done, Begin, Continue, Move, Stay, Implement,
  Post, Send, Create, Update, etc.).
- No `registerShortcut` calls except for panel height.
