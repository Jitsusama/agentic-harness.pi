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

## Making a Tool Load on Demand

Register it with `exposure: "deferred"`, and give a set of tools that
go together a shared `namespace` with a description. Defer a tool
when sessions seldom call it; a tool most sessions call is cheaper
declared.