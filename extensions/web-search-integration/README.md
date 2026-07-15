# Web Search Extension

Gives the agent the ability to search the web and read web
pages using a headless Chrome browser.

## Tools

**`web_search`**: Searches the web and returns titles, URLs and
snippets. The agent uses this to research best practices, look
up APIs, understand problem domains and so on. DuckDuckGo is the
primary provider; Bing is the fallback when DuckDuckGo returns
nothing or errors.

**`web_read`**: Fetches a URL and captures it as a bundle of
representations written to a private temp directory: article
markdown (extracted with defuddle), the rendered inner text, the
DOM and bounded screenshot tiles. The tool returns a compact
manifest of file paths plus a short excerpt, so the agent opens
only the representation it needs with `read` (offset/limit for
prose, viewing a screenshot tile as an image) or `grep`, instead
of pulling every representation into context.

Screenshots are captured as fixed-width vertical tiles, each
kept under the model provider's image dimension limit, so a long
page can never produce an image the model rejects. A page taller
than the tile budget is truncated and the manifest says so. Old
bundles are reaped at session start so authenticated captures do
not linger in the temp dir.

## Requirements

- Google Chrome installed (or set `CHROME_PATH` env var)
- Dependencies: `puppeteer-core`, `defuddle`, `jsdom`

## How It Works

A headless Chrome instance launches on first use and gets
reused across tool calls within a session. It closes
automatically when the session ends. Search tries DuckDuckGo's
HTML interface first and falls back to Bing's; Google blocks
headless browsers, so it is not used. Page reading renders the
full page (including JavaScript) before extracting content.
