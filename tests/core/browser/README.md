# The Browser Lane

Tests of `../../../lib/core/web/` that drive a real Chrome against a page
served from `_harness.ts`, for what only a browser shows: an override it
ignored, an event on the wrong session, a handle gone stale. They run apart
from the unit suite, through `pnpm test:browser` and
`vitest.browser.config.ts`, since they need a Chrome. A test that needs no
browser goes in `../web/`.
