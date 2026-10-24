# Guard Policy Workflow

One control for every guard in the package: the guardians, the
interceptors, the quest gates and the confirmation gates on the
review, Slack and Google tools.

## Modes

Every guard has one of three modes:

- **block**: an approval opens its panel; any other guard
  refuses every time, naming the form to retry with.
- **redirect**: a refusal reaches the agent in its own tool
  result, with what is wrong and the form to retry with, so it
  learns rather than repeating the mistake. When the agent is
  sure the guard is wrong, it makes the same call again,
  unchanged, and the call goes through; the transcript shows the
  override. The override is spent then, so the same mistake made
  later is said again. An approval goes ahead and shows you what
  its panel would have.
- **off**: the action goes ahead, and what the guard saw
  appears in the transcript as a guard report. A report is a
  session entry, not a message, so it never reaches the model
  and costs nothing in context. Nothing a guard sees is silent.

There used to be a `report` mode, which let a refusal through and
told only you. The agent never heard it, so it made the same
mistake on the next call. `redirect` took its place as the
default, and a saved `report` setting is read as `off`, which
does what report did.

While you are away (see [away-workflow](../away-workflow/)), an
approval that blocks holds its call instead of opening its panel:
nothing is sent, the agent is told it is held, and the report says
"held for your return". Nothing is approved by your coming back;
a call still wanted is made again and asks as usual.

## Defaults

The rule behind the defaults is that a guard blocks only where a
mistake reaches somebody else or cannot be undone, or where the
refusal tells the agent exactly what to do instead:

- Approvals over this machine and changes you own redirect:
  `commit`, `pr`, `issue`, `review-offer`, `review-say` and
  `review-publish` go ahead and show you what they would have
  asked.
- Approvals that reach other people block: `slack`, `google`,
  and `mesh-end-hold`, which asks before a session ends
  another session's hold on your word.
- Form guards block: each names the one right form to retry
  with, and a PR, issue or commit that reaches other people is
  held to it.
- Safety blocks only the irrecoverable: `history` redirects,
  `history-destructive` blocks with the safe form, and leases a
  bare force push rather than refusing it.

Two guards are exceptions. `git-cli` splits chained commands so
each panel sees one command, so it follows `commit`, `pr` and
`issue`: it blocks when any of them blocks and is off
otherwise, since a chain no panel will read needs no splitting.
`quest-untracked-tree` redirects by adopting the tree the write
lands in, which is all its refusal ever asked for.

`/guards` lists every guard with its class, mode, where the mode
came from and what it last did.

## Setting Modes

A mode can be set for a guard by name, for a group (`git`,
`github`, `format`, `review`, `send`, `quest`), for a class
(`approval`, `form`, `safety`) or for `all`.

```text
/guards                      list every guard
/guards commit block         ask before every commit, this session
/guards review block         ask before every review write
/guards all off              let everything through, with reports
/guards reset                drop this session's settings
```

A session setting is saved in the session and restored when it
resumes. While any is in force, the footer shows a quiet flag,
`⚑`, with a count once there is more than one; `/guards` says
which, since each of its rows names where its mode came from.
For a standing setting, put a `guards` section in the
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
