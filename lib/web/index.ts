/**
 * Web library: search the web and extract readable content
 * from pages using headless Chrome.
 *
 * Public entry point for external consumers. Browser
 * lifecycle, cookie extraction and DOM cleanup are
 * implementation details: use `webSearch` and `readPage`.
 */

export { type AxNode, renderAxOutline } from "./a11y.js";
export { closeBrowser, killBrowserSync } from "./browser.js";
export { AuthSetupNeeded, type PageContent, readPage } from "./reader.js";
export { type SearchResult, webSearch } from "./search.js";
export {
	type ActResult,
	BrowserSession,
	type Observation,
	type PageAction,
} from "./session.js";
export {
	resolveTarget,
	type SemanticTarget,
	type TargetResolution,
} from "./target.js";
