# Keybinding Audit

A complete inventory of every keybinding across all four layers
of the input stack: macOS, WezTerm, Pi and this repository's
extensions. The purpose is to identify conflicts, understand
which keys are available and establish a consistent keybinding
strategy for extensions in this repository.

**Environment:** macOS with Colemak DH ANSI layout, WezTerm
terminal, Pi coding agent.

**Custom overrides:** No custom `keybindings.json` for Pi, no
custom WezTerm key bindings, no macOS `DefaultKeyBinding.dict`,
no `NSUserKeyEquivalents`, no Karabiner or BetterTouchTool.
Three macOS symbolic hotkeys explicitly disabled (input source
switching and Spotlight).

**Key delivery chain:** macOS intercepts `Cmd` combos at the
system/app level (WezTerm sees them as `Super`). WezTerm
intercepts its own bindings before the terminal. Everything
else reaches Pi. Pi's built-in bindings fire first, then
extension `registerShortcut` bindings, then contextual panel
and gate keys.

---

## 1. macOS Default Shortcuts

### 1.1 Common (System-Wide)

| Shortcut | Action |
|---|---|
| `Cmd+X` | Cut |
| `Cmd+C` | Copy |
| `Cmd+V` | Paste |
| `Cmd+Z` | Undo |
| `Shift+Cmd+Z` | Redo |
| `Cmd+A` | Select all |
| `Cmd+F` | Find |
| `Cmd+G` | Find next |
| `Shift+Cmd+G` | Find previous |
| `Cmd+H` | Hide front app |
| `Option+Cmd+H` | Hide all other apps |
| `Cmd+M` | Minimise front window |
| `Option+Cmd+M` | Minimise all windows of front app |
| `Cmd+O` | Open |
| `Cmd+P` | Print |
| `Cmd+Q` | Quit app |
| `Cmd+S` | Save |
| `Cmd+T` | New tab |
| `Cmd+W` | Close front window |
| `Option+Cmd+W` | Close all windows of app |
| `Option+Cmd+Esc` | Force quit |
| `Cmd+Space` | Spotlight search (**disabled**) |
| `Option+Cmd+Space` | Spotlight search from Finder |
| `Ctrl+Cmd+Space` | Character viewer |
| `Ctrl+Cmd+F` | Toggle app fullscreen |
| `Cmd+Tab` | Switch to next app |
| `Cmd+`` ` `` | Switch windows of front app |
| `Shift+Cmd+5` | Screenshot/recording |
| `Shift+Cmd+3` | Screenshot (full screen) |
| `Shift+Cmd+4` | Screenshot (selection) |
| `Shift+Cmd+N` | New folder (Finder) |
| `Ctrl+Cmd+N` | New folder with selection |
| `Cmd+,` | Open app settings |

### 1.2 Sleep, Log Out, Shut Down

| Shortcut | Action |
|---|---|
| `Ctrl+Cmd+Q` | Lock screen |
| `Shift+Cmd+Q` | Log out (confirm) |
| `Option+Shift+Cmd+Q` | Log out (immediate) |
| `Ctrl+Shift+Power` | Display sleep |
| `Ctrl+Power` | Restart/sleep/shut down dialog |
| `Ctrl+Cmd+Power` | Force restart |
| `Ctrl+Option+Cmd+Power` | Quit all and shut down |

### 1.3 Finder and System

| Shortcut | Action |
|---|---|
| `Cmd+D` | Duplicate files |
| `Cmd+E` | Eject disk |
| `Cmd+F` | Spotlight search in Finder window |
| `Cmd+I` | Get Info |
| `Cmd+R` | Show original (alias) / refresh |
| `Shift+Cmd+C` | Computer window |
| `Shift+Cmd+D` | Desktop folder |
| `Shift+Cmd+F` | Recents window |
| `Shift+Cmd+G` | Go to Folder |
| `Shift+Cmd+H` | Home folder |
| `Shift+Cmd+I` | iCloud Drive |
| `Shift+Cmd+K` | Network window |
| `Option+Cmd+L` | Downloads folder |
| `Shift+Cmd+O` | Documents folder |
| `Shift+Cmd+P` | Preview pane |
| `Shift+Cmd+R` | AirDrop window |
| `Shift+Cmd+T` | Tab bar in Finder |
| `Ctrl+Shift+Cmd+T` | Add Finder item to Dock |
| `Shift+Cmd+U` | Utilities folder |
| `Option+Cmd+D` | Show/hide Dock |
| `Ctrl+Cmd+T` | Add item to sidebar |
| `Option+Cmd+P` | Path bar in Finder |
| `Option+Cmd+S` | Sidebar in Finder |
| `Cmd+/` | Status bar in Finder |
| `Cmd+J` | View Options |
| `Cmd+K` | Connect to Server |
| `Ctrl+Cmd+A` | Make alias |
| `Cmd+N` | New Finder window |
| `Option+Cmd+N` | New Smart Folder |
| `Option+Cmd+T` | Toolbar in Finder |
| `Option+Cmd+V` | Move (paste + delete original) |
| `Cmd+Y` | Quick Look |
| `Option+Cmd+Y` | Quick Look slideshow |
| `Cmd+1` | Icon view |
| `Cmd+2` | List view |
| `Cmd+3` | Column view |
| `Cmd+4` | Gallery view |
| `Cmd+[` | Previous folder |
| `Cmd+]` | Next folder |
| `Cmd+Up` | Parent folder |
| `Ctrl+Cmd+Up` | Parent folder in new window |
| `Cmd+Down` | Open selected item |
| `Cmd+Delete` | Move to Trash |
| `Shift+Cmd+Delete` | Empty Trash |
| `Option+Shift+Cmd+Delete` | Empty Trash (no confirm) |
| `Ctrl+Up` | Mission Control |
| `Ctrl+Down` | App windows (App Exposé) |
| `Ctrl+Space` | Previous input source (**disabled**) |
| `Ctrl+Option+Space` | Next input source (**disabled**) |

### 1.4 Text Editing (Cocoa)

These apply in standard macOS text fields. Pi's TUI replaces
them with its own bindings, but they matter for understanding
what macOS apps normally expect on `Ctrl` combos.

| Shortcut | Action |
|---|---|
| `Cmd+B` | Bold |
| `Cmd+I` | Italic |
| `Cmd+K` | Add web link |
| `Cmd+U` | Underline |
| `Cmd+T` | Fonts window |
| `Cmd+D` | Select Desktop in dialogs |
| `Ctrl+Cmd+D` | Show/hide definition |
| `Shift+Cmd+:` | Spelling and Grammar |
| `Cmd+;` | Find misspelled words |
| `Option+Delete` | Delete word left |
| `Ctrl+H` | Delete character left |
| `Ctrl+D` | Delete character right |
| `Ctrl+K` | Kill to end of paragraph |
| `Ctrl+Y` | Yank (paste kill buffer) |
| `Ctrl+A` | Move to line/paragraph start |
| `Ctrl+E` | Move to line/paragraph end |
| `Ctrl+F` | Move one character forward |
| `Ctrl+B` | Move one character backward |
| `Ctrl+L` | Centre cursor in visible area |
| `Ctrl+P` | Move up one line |
| `Ctrl+N` | Move down one line |
| `Ctrl+O` | Insert new line after cursor |
| `Ctrl+T` | Transpose characters |
| `Cmd+Up` | Move to document start |
| `Cmd+Down` | Move to document end |
| `Cmd+Left` | Move to line start |
| `Cmd+Right` | Move to line end |
| `Option+Left` | Move to previous word start |
| `Option+Right` | Move to next word end |
| `Shift+Cmd+Up` | Select to document start |
| `Shift+Cmd+Down` | Select to document end |
| `Shift+Cmd+Left` | Select to line start |
| `Shift+Cmd+Right` | Select to line end |
| `Option+Shift+Left` | Extend selection word left |
| `Option+Shift+Right` | Extend selection word right |
| `Option+Shift+Up` | Extend selection paragraph up |
| `Option+Shift+Down` | Extend selection paragraph down |
| `Cmd+{` | Left align |
| `Cmd+}` | Right align |
| `Shift+Cmd+\|` | Centre align |
| `Option+Cmd+F` | Go to search field |
| `Option+Cmd+T` | Show/hide toolbar |
| `Option+Cmd+C` | Copy Style |
| `Option+Cmd+V` | Paste Style |
| `Option+Shift+Cmd+V` | Paste and Match Style |
| `Option+Cmd+I` | Inspector window |
| `Shift+Cmd+P` | Page setup |
| `Shift+Cmd+S` | Save As / duplicate |
| `Shift+Cmd+-` | Decrease size |
| `Shift+Cmd++` | Increase size |
| `Cmd+=` | Increase size |
| `Shift+Cmd+?` | Help menu |

### 1.5 Accessibility and Focus

| Shortcut | Action |
|---|---|
| `Ctrl+Option+Cmd+8` | Invert colours |
| `Ctrl+Option+Cmd+,` | Reduce contrast |
| `Ctrl+Option+Cmd+.` | Increase contrast |
| `Ctrl+F2` | Focus menu bar |
| `Ctrl+F3` | Focus Dock |
| `Ctrl+F4` | Focus active/next window |
| `Ctrl+F5` | Focus window toolbar |
| `Ctrl+F6` | Focus floating window |
| `Ctrl+Shift+F6` | Focus previous panel |
| `Ctrl+F7` | Change Tab focus mode |
| `Ctrl+F8` | Focus status menu |
| `Ctrl+Tab` | Next control (in text field) |
| `Ctrl+Shift+Tab` | Previous control group |
| `Option+Cmd+F5` | Accessibility Shortcuts panel |

### 1.6 Window Tiling

| Shortcut | Action |
|---|---|
| `Fn+Ctrl+F` | Fill desktop |
| `Fn+Ctrl+C` | Centre on desktop |
| `Fn+Ctrl+Left` | Left half |
| `Fn+Ctrl+Right` | Right half |
| `Fn+Ctrl+Up` | Top half |
| `Fn+Ctrl+Down` | Bottom half |
| `Fn+Ctrl+R` | Return to previous size |
| `Fn+Ctrl+Shift+Left` | Left & Right tile |
| `Fn+Ctrl+Shift+Right` | Right & Left tile |
| `Fn+Ctrl+Shift+Up` | Top & Bottom tile |
| `Fn+Ctrl+Shift+Down` | Bottom & Top tile |
| `Fn+Ctrl+Option+Shift+Left` | Left & Quarters |
| `Fn+Ctrl+Option+Shift+Right` | Right & Quarters |
| `Fn+Ctrl+Option+Shift+Up` | Top & Quarters |
| `Fn+Ctrl+Option+Shift+Down` | Bottom & Quarters |

---

## 2. WezTerm Default Bindings

WezTerm config notes:
- `send_composed_key_when_left_alt_is_pressed = false`
- `send_composed_key_when_right_alt_is_pressed = false`
- `enable_kitty_keyboard = true`

Both Alt keys pass through raw to the terminal. Kitty keyboard
protocol is enabled, giving Pi access to key release events
and disambiguated modifiers.

Output from `wezterm show-keys` on the installed version.

### 2.1 Default Key Table

#### Clipboard

| Shortcut | Action |
|---|---|
| `Super+C` | Copy to clipboard |
| `Ctrl+Shift+C` | Copy to clipboard |
| `Copy` (media key) | Copy to clipboard |
| `Super+V` | Paste from clipboard |
| `Ctrl+Shift+V` | Paste from clipboard |
| `Paste` (media key) | Paste from clipboard |
| `Ctrl+Insert` | Copy to primary selection |
| `Shift+Insert` | Paste from primary selection |

#### Window and Tab Management

| Shortcut | Action |
|---|---|
| `Super+N` | New window |
| `Ctrl+Shift+N` | New window |
| `Super+T` | New tab (current pane domain) |
| `Ctrl+Shift+T` | New tab (current pane domain) |
| `Shift+Super+T` | New tab (default domain) |
| `Super+W` | Close current tab (confirm) |
| `Ctrl+Shift+W` | Close current tab (confirm) |
| `Super+M` | Hide (minimise) |
| `Ctrl+Shift+M` | Hide (minimise) |
| `Super+H` | Hide application (macOS) |
| `Ctrl+Shift+H` | Hide application |
| `Alt+Enter` | Toggle fullscreen |

#### Tab Navigation

| Shortcut | Action |
|---|---|
| `Super+1` through `Super+9` | Activate tab 0–8 |
| `Ctrl+Shift+1` through `Ctrl+Shift+9` | Activate tab 0–8 |
| `Shift+Super+[` | Previous tab |
| `Shift+Super+]` | Next tab |
| `Super+{` | Previous tab |
| `Super+}` | Next tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+PageUp` | Previous tab |
| `Ctrl+PageDown` | Next tab |
| `Ctrl+Shift+PageUp` | Move tab left |
| `Ctrl+Shift+PageDown` | Move tab right |

#### Font Size

| Shortcut | Action |
|---|---|
| `Super+-` | Decrease font size |
| `Ctrl+-` | Decrease font size |
| `Ctrl+Shift+-` | Decrease font size |
| `Ctrl+_` | Decrease font size |
| `Super+=` | Increase font size |
| `Ctrl+=` | Increase font size |
| `Ctrl+Shift+=` | Increase font size |
| `Ctrl++` | Increase font size |
| `Super+0` | Reset font size |
| `Ctrl+0` | Reset font size |
| `Ctrl+Shift+0` | Reset font size |

#### Scrollback

| Shortcut | Action |
|---|---|
| `Shift+PageUp` | Scroll up one page |
| `Shift+PageDown` | Scroll down one page |
| `Super+K` | Clear scrollback |
| `Ctrl+Shift+K` | Clear scrollback |

#### Pane Management

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Alt+"` | Split vertical |
| `Ctrl+Shift+Alt+'` | Split vertical |
| `Ctrl+Shift+Alt+%` | Split horizontal |
| `Ctrl+Shift+Alt+5` | Split horizontal |
| `Ctrl+Shift+Left` | Activate pane left |
| `Ctrl+Shift+Right` | Activate pane right |
| `Ctrl+Shift+Up` | Activate pane up |
| `Ctrl+Shift+Down` | Activate pane down |
| `Ctrl+Shift+Alt+Left` | Resize pane left |
| `Ctrl+Shift+Alt+Right` | Resize pane right |
| `Ctrl+Shift+Alt+Up` | Resize pane up |
| `Ctrl+Shift+Alt+Down` | Resize pane down |
| `Ctrl+Shift+Z` | Toggle pane zoom |

#### Utilities

| Shortcut | Action |
|---|---|
| `Super+R` | Reload configuration |
| `Ctrl+Shift+R` | Reload configuration |
| `Super+F` | Search |
| `Ctrl+Shift+F` | Search |
| `Ctrl+Shift+L` | Debug overlay |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+U` | Character select |
| `Ctrl+Shift+X` | Activate copy mode |
| `Ctrl+Shift+Space` | Quick select |
| `Super+Q` | Quit application |
| `Ctrl+Shift+Q` | Quit application |

### 2.2 Copy Mode Key Table

Active after `Ctrl+Shift+X`. Vim-style navigation.

| Shortcut | Action |
|---|---|
| `h` | Move left |
| `j` | Move down |
| `k` | Move up |
| `l` | Move right |
| `w` | Forward word |
| `b` | Backward word |
| `e` | Forward word end |
| `Tab` | Forward word |
| `Shift+Tab` | Backward word |
| `0` | Start of line |
| `$` | End of line content |
| `^` | Start of line content |
| `f` | Jump forward (prev_char=false) |
| `F` | Jump backward (prev_char=false) |
| `t` | Jump forward (prev_char=true) |
| `T` | Jump backward (prev_char=true) |
| `;` | Jump again |
| `,` | Jump reverse |
| `g` | Scrollback top |
| `G` | Scrollback bottom |
| `H` | Viewport top |
| `M` | Viewport middle |
| `L` | Viewport bottom |
| `v` | Cell selection mode |
| `V` | Line selection mode |
| `Ctrl+V` | Block selection mode |
| `Space` | Cell selection mode |
| `o` | Toggle selection other end |
| `O` | Toggle selection other end (horiz) |
| `y` | Yank and close |
| `Enter` | Start of next line |
| `Escape` | Scroll to bottom and close |
| `Ctrl+C` | Scroll to bottom and close |
| `Ctrl+G` | Scroll to bottom and close |
| `q` | Scroll to bottom and close |
| `Ctrl+B` | Page up |
| `Ctrl+F` | Page down |
| `Ctrl+D` | Half page down |
| `Ctrl+U` | Half page up |
| `Alt+B` | Backward word |
| `Alt+F` | Forward word |
| `Alt+M` | Start of line content |
| `Alt+Left` | Backward word |
| `Alt+Right` | Forward word |
| `PageUp` | Page up |
| `PageDown` | Page down |
| `Home` | Start of line |
| `End` | End of line content |
| `Left` | Move left |
| `Right` | Move right |
| `Up` | Move up |
| `Down` | Move down |

### 2.3 Search Mode Key Table

Active during `Super+F` or `Ctrl+Shift+F`.

| Shortcut | Action |
|---|---|
| `Enter` | Previous match |
| `Escape` | Close search |
| `Ctrl+N` | Next match |
| `Ctrl+P` | Previous match |
| `Ctrl+R` | Cycle match type |
| `Ctrl+U` | Clear pattern |
| `PageUp` | Previous match page |
| `PageDown` | Next match page |
| `Up` | Previous match |
| `Down` | Next match |

### 2.4 Mouse Bindings (Default)

| Input | Action |
|---|---|
| Single click | Select cell |
| `Shift+click` | Extend selection (cell) |
| `Alt+click` | Select block |
| `Shift+Alt+click` | Extend selection (block) |
| Middle click | Paste from primary selection |
| Double click | Select word |
| Triple click | Select line |
| Drag | Extend selection (cell) |
| `Alt+drag` | Extend selection (block) |
| `Ctrl+Shift+drag` | Start window drag |
| `Super+drag` | Start window drag |
| Release | Complete selection / open link |

---

## 3. Pi Built-in Bindings

No custom `~/.pi/agent/keybindings.json` exists; all defaults
are active.

### 3.1 Editor: Cursor Movement

| Shortcut | Action |
|---|---|
| `Up` | Cursor up |
| `Down` | Cursor down |
| `Left`, `Ctrl+B` | Cursor left |
| `Right`, `Ctrl+F` | Cursor right |
| `Alt+Left`, `Ctrl+Left`, `Alt+B` | Word left |
| `Alt+Right`, `Ctrl+Right`, `Alt+F` | Word right |
| `Home`, `Ctrl+A` | Line start |
| `End`, `Ctrl+E` | Line end |
| `Ctrl+]` | Jump forward to character |
| `Ctrl+Alt+]` | Jump backward to character |
| `PageUp` | Page up |
| `PageDown` | Page down |

### 3.2 Editor: Deletion

| Shortcut | Action |
|---|---|
| `Backspace` | Delete character backward |
| `Delete`, `Ctrl+D` | Delete character forward |
| `Ctrl+W`, `Alt+Backspace` | Delete word backward |
| `Alt+D`, `Alt+Delete` | Delete word forward |
| `Ctrl+U` | Delete to line start |
| `Ctrl+K` | Delete to line end |

### 3.3 Editor: Kill Ring and Undo

| Shortcut | Action |
|---|---|
| `Ctrl+Y` | Yank (paste most recently deleted) |
| `Alt+Y` | Yank pop (cycle kill ring) |
| `Ctrl+-` | Undo |

### 3.4 Input

| Shortcut | Action |
|---|---|
| `Shift+Enter` | Insert new line |
| `Enter` | Submit input |
| `Tab` | Tab / autocomplete |

### 3.5 Clipboard and Selection

| Shortcut | Action |
|---|---|
| `Ctrl+C` | Copy selection |
| `Up` | Move selection up |
| `Down` | Move selection down |
| `PageUp` | Page up in list |
| `PageDown` | Page down in list |
| `Enter` | Confirm selection |
| `Escape`, `Ctrl+C` | Cancel selection |

### 3.6 Application

| Shortcut | Action |
|---|---|
| `Escape` | Cancel / abort |
| `Ctrl+C` | Clear editor |
| `Ctrl+D` | Exit (when editor empty) |
| `Ctrl+Z` | Suspend to background |
| `Ctrl+G` | Open in external editor |
| `Ctrl+V` | Paste image from clipboard |

### 3.7 Sessions (Session Picker Context)

| Shortcut | Action |
|---|---|
| `Ctrl+P` | Toggle path display |
| `Ctrl+S` | Toggle sort mode |
| `Ctrl+N` | Toggle named-only filter |
| `Ctrl+R` | Rename session |
| `Ctrl+D` | Delete session |
| `Ctrl+Backspace` | Delete session (when query empty) |

### 3.8 Models and Thinking

| Shortcut | Action |
|---|---|
| `Ctrl+L` | Open model selector |
| `Ctrl+P` | Cycle to next model |
| `Shift+Ctrl+P` | Cycle to previous model |
| `Shift+Tab` | Cycle thinking level |
| `Ctrl+T` | Toggle thinking block display |

### 3.9 Display and Message Queue

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Toggle tool output display |
| `Alt+Enter` | Queue follow-up message |
| `Alt+Up` | Restore queued messages to editor |

### 3.10 Tree Navigation

| Shortcut | Action |
|---|---|
| `Ctrl+Left`, `Alt+Left` | Fold / jump to previous segment |
| `Ctrl+Right`, `Alt+Right` | Unfold / jump to next segment |

---

## 4. Repository Extension Bindings

### 4.1 Global Shortcuts (`pi.registerShortcut`)

Only panel height toggles remain as global shortcuts. All
other features are accessed via slash commands (`/plan`,
`/tdd`, `/pr-review`, `/pr-reply`).

| Shortcut | Extension | Action |
|---|---|---|
| `Ctrl+Alt+F` | panel-height | Toggle fullscreen panel height |
| `Ctrl+Alt+M` | panel-height | Toggle minimised panel height |

### 4.2 Shared UI Infrastructure

These are handled by library components in `extensions/lib/ui/`
and apply across all panels and workspaces that use them.

#### Panel and Prompt Dismissal

| Key | Component | Action |
|---|---|---|
| `Escape` | panel, prompt-single, prompt-workspace, option-list, progress | Cancel / dismiss |

#### Workspace Submission

| Key | Component | Action |
|---|---|---|
| `Ctrl+Enter` | prompt-workspace | Submit workspace |
| `Shift+Escape` | prompt-workspace, prompt-single, action-bar | Redirect (open editor) |

#### Tab Navigation (tab-strip)

| Key | Action |
|---|---|
| `Tab`, `Right` | Next tab |
| `Shift+Tab`, `Left` | Previous tab |
| `Ctrl+1` through `Ctrl+9` | Jump to tab N |

#### List Navigation

| Key | Component | Action |
|---|---|---|
| `Up` | option-list, overview-panel, review-panel, workspace | Move up |
| `Down` | option-list, overview-panel, review-panel, workspace | Move down |
| `Enter` | option-list, overview-panel, workspace | Select / confirm |

#### Scroll Region

| Key | Action |
|---|---|
| `Shift+Up` | Scroll up |
| `Shift+Down` | Scroll down |
| `Shift+Left` | Scroll left (when horizontal scroll enabled) |
| `Shift+Right` | Scroll right (when horizontal scroll enabled) |

### 4.3 Panel Action Keys (Contextual)

These are single-letter action keys shown in the action bar at
the bottom of panels. Only active when their specific panel is
displayed. Pressing a key triggers the corresponding action.

#### Guardians

All four guardians (commit, PR, issue, history) present
confirmation gates.

| Context | Key | Action |
|---|---|---|
| commit-guardian | `a` | Approve |
| commit-guardian | `r` | Reject |
| pr-guardian | `a` | Approve |
| pr-guardian | `r` | Reject |
| issue-guardian | `a` | Approve |
| issue-guardian | `r` | Reject |
| history-guardian | `a` | Approve |
| history-guardian | `r` | Reject |

#### Plan Mode

| Context | Key | Action |
|---|---|---|
| Plan completion gate | `i` | Implement (leave plan mode) |
| Plan completion gate | `s` | Stay in planning |
| Plan interview | `1` | Switch to Question view |

#### TDD Mode

| Context | Key | Action |
|---|---|---|
| Phase transition gate | `m` | Move to next phase |
| Phase transition gate | `s` | Stay in current phase |
| Refactor gate | `a` | Approve refactoring |
| Refactor gate | `r` | Reject refactoring |

#### PR Annotate (Vet Workspace)

Tab-level views:

| Key | Action |
|---|---|
| `1` | Switch to Overview view |
| `2` | Switch to Comments view |
| `3` | Switch to Source view |

Comment actions (within Comments view):

| Key | Action |
|---|---|
| `a` | Approve comment |
| `r` | Reject comment |
| `n` | New comment |
| `Up` | Previous comment |
| `Down` | Next comment |

Global workspace action:

| Key | Action |
|---|---|
| `p` | Mark current tab as passed |

#### PR Review

Overview panel:

| Key | Action |
|---|---|
| `r` | Proceed to review |
| `1` | Switch to Overview view |
| `2` | Switch to References view |
| `3` | Switch to Source view |
| `Up` | Navigate up |
| `Down` | Navigate down |
| `Enter` | Select |

Review panel views:

| Key | Action |
|---|---|
| `1` | Switch to Overview view |
| `2` | Switch to Comments view |
| `3` | Switch to Source view |

Review panel comment actions:

| Key | Action |
|---|---|
| `a` | Approve comment |
| `r` | Reject comment |
| `n` | New comment |
| `p` | Mark tab as passed (global) |
| `Up` | Previous item |
| `Down` | Next item |

Submit panel:

| Key | Action |
|---|---|
| `p` | Post review |

#### PR Reply

Summary panel:

| Key | Action |
|---|---|
| `1` | Switch to Overview view |

Workspace (reviewer tabs):

| Key | Action |
|---|---|
| `1` | Switch to Threads view |
| `p` | Pass thread |
| `Enter` | Enter selected thread |
| `Up` | Previous thread |
| `Down` | Next thread |

Thread gate:

| Key | Action |
|---|---|
| `r` | Reply |
| `p` | Pass |
| `Enter` | Implement |

Reply review:

| Key | Action |
|---|---|
| `a` | Approve reply |
| `r` | Reject reply |

Bookend panels:

| Key | Action |
|---|---|
| `b` | Begin review |
| `c` | Continue |
| `p` | Pass review |
| `r` | Rebase all |
| `s` | Skip (rebase panel only) |

#### Google Workspace

Email send confirmation:

| Key | Action |
|---|---|
| `s` | Send |
| `c` | Cancel |

Email/event delete confirmation:

| Key | Action |
|---|---|
| `d` | Delete |
| `c` | Cancel |

Event create confirmation:

| Key | Action |
|---|---|
| `c` | Create |
| `x` | Cancel |

Event update confirmation:

| Key | Action |
|---|---|
| `u` | Update |
| `c` | Cancel |

#### Ask Tool

| Key | Action |
|---|---|
| `1` | Switch to Question view |

---

## 5. Conflict Analysis

### 5.1 Cross-Layer Conflicts

**`Alt+Enter`** is bound to both WezTerm (toggle fullscreen)
and Pi (queue follow-up message). WezTerm intercepts it first,
so **Pi's `Alt+Enter` never fires**. This is a real conflict.

**`Ctrl+-`** is bound to both WezTerm (decrease font size) and
Pi (undo). WezTerm intercepts it first, so **Pi's undo never
fires via `Ctrl+-`**.

**`Ctrl+=`** is bound to WezTerm (increase font size). Not
currently used by Pi or extensions.

**`Ctrl+0`** is bound to WezTerm (reset font size). Not
currently used by Pi or extensions.

**`Ctrl+Tab`** and **`Ctrl+Shift+Tab`** are bound to WezTerm
(tab navigation). Not used by Pi itself, but the extension
tab-strip uses plain `Tab` and `Shift+Tab` (not `Ctrl+Tab`),
so no actual conflict there.

**`Ctrl+PageUp`** and **`Ctrl+PageDown`** are bound to WezTerm
(tab navigation). Pi doesn't use these, so no conflict.

**`Shift+PageUp`** and **`Shift+PageDown`** are bound to
WezTerm (scroll). Pi doesn't use `Shift+Page` combos. The
extension scroll region uses `Shift+Up`/`Shift+Down`, not
`Shift+PageUp`/`Shift+PageDown`, so no conflict.

### 5.2 WezTerm `Ctrl+Shift` Interceptions

WezTerm intercepts many `Ctrl+Shift+<letter>` combos before
they reach the terminal. These are **not available** to Pi:

`Ctrl+Shift+C`, `Ctrl+Shift+F`, `Ctrl+Shift+H`, `Ctrl+Shift+K`,
`Ctrl+Shift+L`, `Ctrl+Shift+M`, `Ctrl+Shift+N`, `Ctrl+Shift+P`,
`Ctrl+Shift+Q`, `Ctrl+Shift+R`, `Ctrl+Shift+T`, `Ctrl+Shift+U`,
`Ctrl+Shift+V`, `Ctrl+Shift+W`, `Ctrl+Shift+X`, `Ctrl+Shift+Z`,
`Ctrl+Shift+Space`.

Plus `Ctrl+Shift+1` through `Ctrl+Shift+9` (tab switching).

### 5.3 Within-Pi Context Overlaps

These are not true conflicts because they operate in different
Pi contexts (session picker vs main editor, etc.):

- `Ctrl+P`: toggle path (session picker) vs cycle model (main)
- `Ctrl+D`: delete session (picker) vs exit (main, editor empty)
- `Ctrl+C`: copy selection vs clear editor (context-dependent)

**Resolved conflicts:** The PR review overview panel previously
had `r` as both the References view key and the Review action
key. Moving views to numbers (`1`, `2`, `3`) eliminated this
class of collision entirely.

### 5.4 Available Key Space

**`Ctrl+Alt+<letter>`** is the namespace used by this repo's
extensions for global shortcuts. After the keybinding overhaul,
only panel height toggles remain in this space.

Currently used: `F`, `M`.

Available: all other letters.

**`Ctrl+Shift+Alt+<letter>`** is also fully available. WezTerm
only uses `Ctrl+Shift+Alt` with `"`, `%`, `'`, `5` and arrow
keys.

**Single letters** for panel action keys have no conflicts by
design: they only activate when a panel is displayed and the
panel owns the input focus.
