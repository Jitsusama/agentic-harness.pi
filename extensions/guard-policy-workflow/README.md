# Guard Policy Workflow

One control for every guard in the package: the guardians, the
interceptors, the quest gates and the confirmation gates on the
review, Slack and Google tools.

## Modes

Every guard has one of three modes:

- **off**: the guard does nothing.
- **report**: the action goes ahead, and what the guard would
  have shown or said appears in the transcript as a guard
  report. A report is a session entry, not a message, so it
  never reaches the model and costs nothing in context.
- **block**: the guard behaves as guards always have. An
  approval opens its panel; a redirect refuses, naming the form
  to retry with.

## Defaults

The rule behind the defaults is that a guard blocks only where a
mistake reaches somebody else or cannot be undone, or where the
refusal tells the agent exactly what to do instead:

- Approvals over this machine and changes you own report:
  `commit`, `pr`, `issue`, `review-offer`, `review-say` and
  `review-publish`.
- Approvals that reach other people block: `slack` and `google`.
- Redirects block: each names the form to retry with.
- Safety blocks only the irrecoverable: `history` reports,
  `history-destructive` blocks with the safe form, and leases a
  bare force push rather than refusing it.

Two guards are exceptions. `git-cli` splits chained commands so
each panel sees one command, so it follows `commit`, `pr` and
`issue`: it blocks when any of them blocks and reports
otherwise. `quest-untracked-tree` reports by adopting the tree
the write lands in, which is all its refusal ever asked for.

`/guards` lists every guard with its class, mode, where the mode
came from and what it last did.

## Setting Modes

A mode can be set for a guard by name, for a group (`git`,
`github`, `format`, `review`, `send`, `quest`), for a class
(`approval`, `redirect`, `safety`) or for `all`.

```text
/guards                      list every guard
/guards commit block         ask before every commit, this session
/guards review block         ask before every review write
/guards all report           let everything through, with reports
/guards reset                drop this session's settings
```

A session setting is saved in the session and restored when it
resumes. For a standing setting, put a `guards` section in the
package config at `~/.config/pi/agentic-harness.pi/config.json`:

```json
{
  "sections": {
    "guards": {
      "modes": { "approval": "block", "slack": "block" }
    }
  }
}
```

A mode is resolved from the session first, then the config, then
what a guard follows, then its default. Within a layer the most
specific key wins: a guard's name, then its group, its class and
`all`. A session setting beats the config even when it is
broader, since it was said more recently.

## Without This Extension

Each extension declares its own guards when it loads, from one
catalogue in `lib/internal/guardian/guards.ts`, so the defaults
hold with or without this extension. What this extension adds is
the `/guards` command, the config section and the transcript
entries; without it, reports are dropped. A guardian from another
package that declares nothing keeps blocking, as it did before
the policy.
