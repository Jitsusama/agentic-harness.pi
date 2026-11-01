# Terminal

Opens shells in a window, a tab or a pane of whatever terminal you
use, types into them, and asks whether they are still there. The
quest workflow uses it for `spawn`, `spawn-tab`, `spawn-pane`,
`spawn-window` and `restore`. Its drivers live in
`lib/core/internal/terminal`.

## Words

Three layouts, defined by what you see rather than by any one
terminal's words:

- **window**: a new top-level window on the desktop.
- **tab**: a new tab in an existing window.
- **pane**: a split of the current tab, beside what is there.

| Layout | kitty              | wezterm              | tmux           | zellij            |
| ------ | ------------------ | -------------------- | -------------- | ----------------- |
| window | `--type=os-window` | `spawn --new-window` | no             | no                |
| tab    | `--type=tab`       | `spawn`              | `new-window`   | `action new-tab`  |
| pane   | `--type=window`    | `split-pane`         | `split-window` | `action new-pane` |

A multiplexer cannot make a desktop window, so a window asked for
inside tmux or zellij opens in the terminal around it.

## How a Shell Gets Opened

Best first:

1. **Attached**: through the terminal you are in, over its own
   control socket. The new surface is named, typed into and
   watched.
2. **Launched**: a new terminal process. Kitty and wezterm are
   started with a control socket of their own, so their windows
   are typed into and watched too, and they need nothing from your
   configuration; they exit with their last window. Foot,
   alacritty and ghostty, and anything you add, are launched blind:
   the command runs through your login shell and nothing watches
   the window.
3. **Printed**: when no terminal can be reached or started, the
   answer gives you the line to run.

A command always runs under your own startup files. Where the
terminal can be typed into, a bare login shell is opened and the
command typed once its prompt has settled; otherwise it runs
through `$SHELL -l -i -c`. If a tier fails before anything opened,
the next one down is tried and the answer says so.

## Which Terminal You Are In

The terminals' own variables say, and on Linux the process ancestry
confirms it, so a variable inherited from somewhere else is not
believed. A session a mycelium holder keeps (`MYCELIUM_HELD`), as
one reopened after a boot is, runs under its holder rather than a
terminal, so its variables name none; the machine's node is asked
which window is joined to the holder, and that window is where the
session sits. When you are inside more than one, such as pi in zellij in
kitty, tabs and panes go to the innermost (the one you are looking
at) and windows to the innermost that can make one. `nesting`
changes that.

## Settings

In the `terminal` section of
`~/.config/pi/agentic-harness.pi/config.json`. The terminal
(`driver`), the `layout` and the `nesting` are each taken from the
first layer that names them: the call, the quest, the project, the
defaults, then what discovery finds and `tab`.

```json
{
  "sections": {
    "terminal": {
      "defaults": { "driver": "kitty", "layout": "window" },
      "projects": {
        "github:Shopify/world": {
          "layout": "tab",
          "nesting": { "tab": "outermost" }
        }
      },
      "quests": { "QEST-20261013-2ASTPT": { "driver": "zellij" } },
      "drivers": {
        "kitty": { "path": "/etc/profiles/per-user/me/bin/kitty" }
      },
      "launchers": {
        "foot": {
          "window": ["--working-directory={cwd}", "--", "{argv}"],
          "platforms": { "darwin": false }
        }
      },
      "wrap": ["direnv", "exec", "{cwd}"]
    }
  }
}
```

- `nesting` is `innermost` or `outermost`, for every layout or per
  layout.
- `drivers` says where a terminal's program is when PATH will not
  find it. A terminal whose program cannot be found is never
  offered, and naming one is refused with the list of those that
  can be used.
- `launchers` adds a terminal, or replaces a built-in one by id.
  Each layout it can open is an argument list with `{cwd}`,
  `{title}` and `{argv}`, where the command goes; `platforms`
  gives another form, or `false`, for `linux` or `darwin`.
- `wrap` goes in front of every blindly launched command, since a
  prompt hook such as direnv's does not run under `-c`.

A project is named by the same repository key as
`subagent.projects` and `review.ask.projects`.

## Adding a Deep Driver

Implement `TerminalDriver` with `sight`, `spawn`, and optionally
`typeInto`, `identifyCurrent`, `probe` and `launch`, then pass it to
`registerTerminalDriver`. A driver registered without `sight` or
`binary` is used whenever its own `available()` says yes, as it was
before discovery existed.
