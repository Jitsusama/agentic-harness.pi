/**
 * Web library: search the web and extract readable content
 * from pages using headless Chrome.
 *
 * Public entry point for external consumers. Browser
 * lifecycle, cookie extraction and DOM cleanup are
 * implementation details: use `webSearch` and `readPage`.
 */

export { closeBrowser, killBrowserSync } from "./browser.js";
export { AuthSetupNeeded, type PageContent, readPage } from "./reader.js";
export { type SearchResult, webSearch } from "./search.js";
