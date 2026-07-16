# Web Library

Search the web and extract readable content from pages using
headless Chrome.

## Usage

```ts
import {
  webSearch,
  readPage,
  closeBrowser,
} from "agentic-harness.pi/web";
```

- **`webSearch(query, numResults?, signal?)`** — search via
  DuckDuckGo's HTML interface. Returns `SearchResult[]`.
- **`readPage(url, signal?)`** — fetch a URL and capture it as a
  bundle of representations written to a private temp directory:
  article markdown (extracted with defuddle), rendered inner
  text, the DOM and bounded screenshot tiles. Returns a
  `PageBundle` of file paths so the caller can let the model open
  only what it needs.
- **`reapAbandonedBundles()`** — remove page-bundle
  directories owned by sessions that are no longer running. Call
  at session start to reclaim captures left by crashes.
- **`cleanupSessionBundles()`** — remove this session's own
  bundle directory. Call at session shutdown.
- **`closeBrowser()`** — shut down the shared Chrome instance.
  Call at session end.

### Screenshot Tiling

A page that defeats text extraction still needs to be seen, but a
full-page screenshot of a long page exceeds the model provider's
image dimension limit. `readPage` captures the page as a stack of
fixed-width vertical tiles, each kept under the long-edge limit,
so a capture can never produce an image the model rejects. A page
taller than the tile budget is truncated and the bundle says so.

## Internal Modules

These are implementation details, not part of the public
barrel:

- **`browser.ts`** — Chrome lifecycle: launch, page creation,
  shutdown. Shared by search and reader.
- **`cookies/`** — Chrome cookie extraction, decryption and
  puppeteer injection. Enables authenticated page access.
  The extension's `/setup-chrome-cookies` command imports
  directly from here.
