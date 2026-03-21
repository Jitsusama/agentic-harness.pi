# Web Search Extension

Gives the agent the ability to search the web and read web
pages using a headless Chrome browser.

## Tools

**`web_search`**: Searches the web (via DuckDuckGo) and returns
titles, URLs and snippets. The agent uses this to research best
practices, look up APIs, understand problem domains and so on.

**`web_read`**: Fetches a URL and extracts readable text content
using Mozilla Readability. Junk elements (ads, nav, cookies,
comments, social buttons, related articles) are stripped before
extraction, and boilerplate lines are removed after.

Pages under ~12k characters come back inline. Larger pages get
saved to `/tmp/pi-web-read/<id>/page.md` so the agent can
explore them selectively with `read` (offset/limit) or `grep`
instead of consuming the entire content as tokens.

## Requirements

- Google Chrome installed (or set `CHROME_PATH` env var)
- Dependencies: `puppeteer-core`, `@mozilla/readability`,
  `jsdom`

## How It Works

A headless Chrome instance launches on first use and gets
reused across tool calls within a session. It closes
automatically when the session ends. Search uses DuckDuckGo's
HTML interface (Google blocks headless browsers). Page reading
renders the full page (including JavaScript) before extracting
content.
