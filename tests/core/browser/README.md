# The Browser Lane

Tests of `../../../lib/core/web/` that drive a real Chrome against a page
served from `_harness.ts`, for what only a browser shows: an override it
ignored, an event on the wrong session, a handle gone stale. They run apart
from the unit suite, through `pnpm test:browser` and
`vitest.browser.config.ts`, since they need a Chrome. A test that needs no
browser goes in `../web/`.

A page a test serves is written in the test when it is a few lines, through
`page`, and otherwise kept whole in `pages/` as HTML, read with `pageFile`,
so its markup and its script are linted as what they are.

## Folders

- `pages/`: the pages tests serve that run past a few lines, each a whole
  HTML document named for its title.
