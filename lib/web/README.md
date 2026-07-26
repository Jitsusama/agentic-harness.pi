# lib/web

Driving a browser, and reading back everything it knows.

Other Pi packages can use any part of this without loading the
[`browser-integration`](../../extensions/browser-integration)
extension, which is a thin consumer of it.

## The Front Door

[`index.ts`](./index.ts) exports the session that drives a real
Chrome, the one-shot page reader, and web search. Everything
else lives in a subdomain barrel beside it, because the whole
surface in one namespace would be several hundred names, and
somebody who wants contrast arithmetic should not have to load
a browser to get it.

## Subdomains

| Directory | What it is for |
|---|---|
| [`a11y/`](./a11y) | The accessibility tree, reading order, live region announcements, keyboard walks |
| [`audit/`](./audit) | Verdicts: axe, structural and layout rules, contrast and target-size arithmetic, sweeps, the digest |
| [`compare/`](./compare) | Diffing a page against a baseline of itself |
| [`design/`](./design) | What a page is built from, and where it drifted |
| [`element/`](./element) | One element in depth: box, styles, listeners, animations, actionability |
| [`envelope/`](./envelope) | Paging, budgets and the on-disk artifact sink |
| [`environment/`](./environment) | Emulation, storage, network shaping, session status |
| [`evaluate/`](./evaluate) | Running an expression and surviving the result |
| [`input/`](./input) | Key chords, pointer paths, touch gestures |
| [`perf/`](./perf) | Web vitals from the browser's own observers |
| [`snapshot/`](./snapshot) | The whole page flattened, frames and shadow content included, and queries over it |
| [`sourcemap/`](./sourcemap) | Where generated code was authored |
| [`styles/`](./styles) | Computed style curation and cascade tracing |
| [`target/`](./target) | Naming an element by role and accessible name |
| [`telemetry/`](./telemetry) | Console, network, dialogs, downloads, lifecycle |
| [`wait/`](./wait) | Conditions worth waiting for |

## Four Commitments

### Everything Reported Comes From the Browser

Roles and names come from the accessibility tree, styles from
the cascade, layout from what was actually painted. Nothing here
parses CSS or reimplements an ARIA rule, because the renderer
already did it and will keep doing it correctly after the
specification changes.

Two places knowingly depart, and both say so at the top of the
file. [`sourcemap/`](./sourcemap) decodes a format itself
because Chrome reports the map's URL and stops: resolving a
position is the devtools front end's job and there is no
protocol call to defer to. And rendering judgments, the
visually-hidden idiom, what counts as small text, how a value
reads once serialized, are presentational and are labelled as
such where they are made.

### Analysis Is Capture Agnostic

Every subdomain but `session` takes serializable data and
returns answers. The same functions judge a live page, a stored
capture, or one taken by Playwright or raw CDP.

That is enforced rather than intended:
[`tests/lib/web/purity.test.ts`](../../tests/lib/web/purity.test.ts)
walks the static imports from each analysis barrel and fails if
any reaches puppeteer, jsdom, pixelmatch, pngjs or axe. It had
been broken three times by accident before the test existed,
never visibly.

### The Session Is the Full Verb Surface

`BrowserSession` is the one place that talks to CDP. If the
browser can do it, the session exposes it as a method that
returns data, not a rendered string. Rendering lives beside the
model it renders, never inside it.

### Nothing Caps Power

Every limit is a presentation default with an override, and
anything too large for an answer goes to disk with its path
reported. A budget should shape how something is said, never
what can be asked.

## Testing

Unit tests live under [`tests/lib/web`](../../tests/lib/web),
mirroring this layout. They assert observable behaviour through
each barrel, never internals.

Fixtures mirror real captures. A fixture invented from a mental
model tests the model rather than the protocol: one written from
an assumption about shadow DOM passed happily while the code
underneath it was wrong, and only live output caught it.
