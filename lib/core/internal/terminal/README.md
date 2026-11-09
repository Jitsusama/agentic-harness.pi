# Terminal Internals

What `lib/terminal` opens shells with: the registry of terminal
drivers and the built-in ones in the order discovery tries them,
the launchers that start a terminal with only a directory and a
command, where each terminal's binary is, the terminals a process
runs under, and running a terminal's control cli on a clock. The
public surface, its types and the person's settings are in
`lib/terminal`.

## Folders

- `drivers/`: one driver a terminal, for kitty, wezterm, zellij and
  tmux, the fallback that prints the request when nothing else
  can open it, and the shell quoting they share.
