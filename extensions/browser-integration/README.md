# browser-integration

Lets the agent drive a real browser through named, persistent
sessions, addressing elements the way it already thinks: role
plus accessible name.

## What It Does

Three tools share one session registry, each named for what the
caller is doing:

- `browser_go` puts a session somewhere: `navigate` to a URL
  (opening a session when none is live), `open` a session, or
  `close` it.
- `browser_see` reads the page and changes nothing. Kind
  `page` returns the accessibility tree as a nested
  role-and-name outline (from `lib/web/a11y`), which reads
  like a description of the page rather than a dump of nodes.
  No opaque node handles reach the model.
- `browser_do` changes the page. Kind `act` clicks or types,
  targeting an element by its role and accessible name,
  narrowed by container or by the 1-based ordinal among
  same-named matches. An ambiguous target comes back as a
  prompt to narrow it rather than a wrong click. A fresh page
  view follows every act, so the agent always sees the result
  of what it did.

Sessions persist across tool calls and dispose on idle and at
session shutdown, on the hardened shared browser lifecycle, so
nothing leaks. Subagents can drive too.

## Design

The accessibility outline and semantic target resolution live
in `lib/web` as pure, tested logic; the session abstraction
drives a real tab over CDP, resolving a target through the
browser's own accessibility matching. This extension is the
thin wiring: one module per tool (`go.ts`, `see.ts`, `do.ts`),
the shared answer shape in `result.ts`, and the named-session
registry with its idle timers in `registry.ts`.

## Growing

The tool family is the surface of a larger plan: turning this
into a full inspection, telemetry and audit surface (element
truth, screen-reader narration, accessibility verdicts,
console and network telemetry, visual comparison). Kinds are
added phase by phase, and a fourth tool, `browser_check`,
joins the family when it has verdicts to report.
