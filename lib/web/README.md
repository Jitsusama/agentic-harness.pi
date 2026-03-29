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
- **`readPage(url, signal?)`** — fetch a URL, extract readable
  content with Mozilla Readability. Returns `PageContent`.
  Large pages are saved to a temp file.
- **`closeBrowser()`** — shut down the shared Chrome instance.
  Call at session end.

## Internal Modules

These are implementation details, not part of the public
barrel:

- **`browser.ts`** — Chrome lifecycle: launch, page creation,
  shutdown. Shared by search and reader.
- **`cookies/`** — Chrome cookie extraction, decryption and
  puppeteer injection. Enables authenticated page access.
  The extension's `/setup-chrome-cookies` command imports
  directly from here.
