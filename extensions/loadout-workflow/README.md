# Loadout Workflow

Loads the tools a session seldom needs when it needs them, rather than
declaring them on every turn.

## Why

Every declared tool is read again on every turn, at the cache-read
price. The home session's first request declared 76 tools in 141,239
characters, and about 20 of them, with their rules, had not been
called once from 8 October. A tool registered with `deferred`
exposure is not declared; pi's built-in `tool_search` finds and
declares it. Since agentic-harness.pi#641, a tool added mid-session
keeps the cache, so loading one costs about the size of its
declaration.

## What It Does

- **Turns `tool_search` on** at the start of a session, so a deferred
  tool can always be loaded.
- **Says what can be loaded** in a `loadable_tools` prompt section: a
  namespace on one line with its tools, any other tool with the first
  sentence of its description. It is worked out once per runtime and
  lists loaded tools too, so the section stays the same within a
  session. It is not part of the resident block, whose freeze outlives
  a reload.
- **Loads what a skill names.** When the model reads a `SKILL.md` that
  names a deferred tool by its whole name, that tool, and the rest of
  its namespace, is declared, and the read says so.
- **Lists a skill or a tool only where it applies**, when the package
  config says where. A skill left out of the list can still be read by
  its path, and a tool left out of the index can still be found with
  `tool_search` or loaded by a skill that names it.
- **Waits for the session's MCP servers after a reload.** The first
  run after a reload or a restart waits, for at most 10 seconds, until
  every MCP server the session had has registered its tools again.
  Without the wait, pi built that run's prompt before the servers
  connected: a server's summary, the tools loaded from it and its line
  in the index dropped out, and came back later, rewriting the cache
  each time. A session that had no MCP server never waits.

## Listing Skills and Tools Where They Apply

The skills list is read again on every turn too: 25,668 characters,
a fifth of a fresh session, on 25 October. The `loadout` section of
the package config (`~/.config/pi/agentic-harness.pi/config.json`)
names skills, or name prefixes ending in `*`, and the folders a
session must run under for them to be listed:

```json
{
  "sections": {
    "loadout": {
      "skills": { "shopify-world-*": ["~/world"] },
      "tools": { "mastery_*": ["~/src/joel.gerber.pi"] }
    }
  }
}
```

`tools` places the on-demand tools' lines in the index the same way:
the mastery tools' line is about 545 characters a turn, and they serve
only one checkout.

The most specific key wins, so `shopify-vault-guide` can be listed
everywhere beside `shopify-*` listed in one place. A key with no
folders lists its names nowhere, and a name no key names is listed
everywhere. The config is read when a session starts.

The package lists five of its own skills nowhere, under the person's
keys: `review-audit-format`, `review-council-format`,
`review-critique-format`, `review-judge-format` and
`review-stack-format`. They are a review round's output
contracts, attached by path to the round's own isolated pi, where this
extension doesn't run, so the round still lists its contract. Listed in
every other session they cost about 2,300 characters a turn. A person's
key for them wins over the package's.

## Making a Tool Load on Demand

Register it with `exposure: "deferred"`, and give a set of tools that
go together a shared `namespace` with a description. Defer a tool
when sessions seldom call it; a tool most sessions call is cheaper
declared.