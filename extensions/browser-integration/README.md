# browser-integration

Lets the agent drive a real browser through named, persistent
sessions, addressing elements the way it already thinks: role
plus accessible name.

## What it does

- One `browser` tool with structured actions: `open` a
  session, `navigate` to a URL, `observe` the page, `act` on
  it, and `close`.
- `observe` returns the page's accessibility tree as a nested
  role-and-name outline (from `lib/web/a11y`), which reads
  like a description of the page rather than a dump of nodes.
  No opaque node handles reach the model.
- `act` clicks or types, targeting an element by its role and
  accessible name, disambiguated by container or by the
  1-based ordinal among same-named matches. An ambiguous
  target comes back as a prompt to disambiguate rather than a
  wrong click. A fresh `observe` follows every act, so the
  agent always sees the result of what it did.
- Sessions are persistent across tool calls and dispose on
  idle and at session shutdown, on the hardened shared browser
  lifecycle, so nothing leaks. Subagents can drive too.

## Design

The accessibility outline and semantic target resolution live
in `lib/web` as pure, tested logic; the session abstraction
drives a real tab over CDP, resolving a target through the
browser's own accessibility matching. This extension is the
thin wiring plus the named-session registry and idle timers.

## Not yet wired

The fallback ladder's final rung (a coordinate click from a
screenshot via a vision model) and mermaid diagram rendering
are follow-ups; the accessible-name path covers well-built
pages today.
