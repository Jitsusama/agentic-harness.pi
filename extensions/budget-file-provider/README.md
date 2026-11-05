# Budget File Provider

Says what a quest's budget means from a file you keep. A quest names
the budget its model calls draw on with `quest budget` (see the
quest-workflow README); a provider says what that name means. This
one reads `~/.config/pi/agentic-harness.pi/budgets/`, or the same
path under `XDG_CONFIG_HOME`:

- `<name>.env`: the variables a session drawing on the budget runs
  with, one `KEY=value` a line. `# label: <words>` sets what the
  status line shows beside the name; other `#` lines are comments.
- `<name>`, executable and without a suffix: run each time a session
  takes the budget up, and its output read the same way. Use it for
  a key kept in a password manager or one minted fresh.

A file wins over a program of the same name. A name with neither is
left to the next provider. A file that sets nothing, or has a line
that isn't `KEY=value`, leaves the session on its default key and
says why.

```sh
# ~/.config/pi/agentic-harness.pi/budgets/acme.env
# label: Acme's Anthropic workspace
ANTHROPIC_API_KEY=sk-ant-...
```

It is asked before any other provider, so your own file wins over a
company's provider that knows the same name. Keep the folder to
yourself (`chmod 700`), since it holds keys.
