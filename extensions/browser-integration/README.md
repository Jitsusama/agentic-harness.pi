# browser-integration

Lets the agent drive a real browser and read back everything it
knows, addressing elements the way it already thinks: role plus
accessible name.

## What It Does

Four tools share one session registry, each named for what the
caller is doing.

### `browser_go` puts a session somewhere

`navigate` to a URL (opening a session when none is live),
`open` one, `close` it, `reload`, or step `back` and `forward`.
Beyond location, it decides the conditions the page runs under:

- `emulate` a different visitor, by device, viewport, media
  preference, sight, locale or clock
- `network` to mock, block, throttle or go offline
- `storage` to read, write or clear what the page has kept
- `dialogs` to decide how alerts and confirms get answered

### `browser_see` reads and changes nothing

- `page`: the accessibility tree as a nested role-and-name
  outline, which reads like a description rather than a dump
- `reading`: what a screen reader would say, in order
- `announcements`: what live regions have said
- `element`: one element in depth, with an optional `why` that
  traces a property through every rule that had a say
- `query`: search the whole page, frames and shadow content
  included, by tag, attribute, class or text
- `logs`, `requests`, `downloads`: what the page said, fetched
  and was handed
- `shot`: a screenshot to disk, never inline
- `vitals`: what the page cost, from the browser's observers
- `status`: where the session actually stands

### `browser_do` changes the page

- `act`: click or type at an element named by role and name,
  waiting for it to become actionable first
- `press`: key chords, `input`: raw pointer and touch gestures
- `wait`: for a selector, text, network quiet, a request, or
  animations to settle
- `eval`: run an expression and get an honest answer, exceptions
  included

### `browser_check` forms a verdict

- `keyboard`: tab through the page and report traps, controls
  that cannot be reached, and focus that cannot be seen
- `accessibility`: the axe WCAG rule set merged with structural
  rules of our own
- `visual`: what the layout did wrong
- `design`: what the page is built from, and its drift
- `compare`: diff against a stored baseline of itself
- `perf`: web vitals against their published thresholds
- `health`: all of the above, as one digest

Any check but `keyboard` takes `widths` and answers with a table
across them, because most layout faults are conditional.

## How It Reads

Every check opens the same way: `PASS`, `WARN` or `FAIL`, a
headline, and what was measured. Two rules make that worth
trusting.

Uncertainty is never approval. Anything undecided warns rather
than passes: text over a gradient, a page with no focusable
controls, a first comparison with no baseline. A checker that
turns its own doubt into a pass is worse than no checker.

A clean result says what it looked at. "Nothing failed" and
"nothing failed across 41 elements and the axe rule set" are the
same verdict and very different reassurances, and the first is
also what a checker that silently did nothing says.

## Shape

- `index.ts` registers the four tools and the session registry
- `go.ts`, `see.ts`, `do.ts`, `check.ts`: one file per verb
- `registry.ts`: named sessions and their lifetimes
- `result.ts`: the one answer shape all four return
- `render.ts`: how calls and results read in the transcript

Everything the tools actually know how to do lives in
[`lib/web`](../../lib/web). This extension is Pi wiring: tool
registration, parameter schemas, rendering and refusals.

## Notes

Screenshots and archives never return inline. They go to a
session bundle directory and the answer carries the paths, since
a large image in a transcript costs more than it explains.
`see status` lists everything written, because a file in an
unnamed temporary directory is unopenable.

Each session gets its own browser context. Anything context
shaped, downloads and clipboard permissions among them, carries
that context's id: without it Chrome silently cancels the
operation and reports nothing wrong.
