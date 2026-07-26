/**
 * Driving a browser, and reading back everything it knows.
 *
 * This barrel is the front door: the session that drives a real
 * Chrome, the one-shot page reader, and web search. Everything
 * else lives in a subdomain barrel beside it, because the whole
 * surface in one namespace would be several hundred names, and
 * a consumer who wants contrast arithmetic should not have to
 * load a browser to get it.
 *
 * The subdomains, and what each is for:
 *
 * - `a11y/`      the accessibility tree, reading order, live
 *                region announcements, keyboard walks
 * - `audit/`     verdicts: axe, structural and layout rules,
 *                contrast and target-size arithmetic, sweeps
 * - `compare/`   diffing a page against a baseline of itself
 * - `design/`    what a page is built from, and its drift
 * - `element/`   one element in depth: box, styles, listeners,
 *                animations, actionability
 * - `envelope/`  paging, budgets and the on-disk artifact sink
 * - `environment/` emulation, storage, network shaping, status
 * - `evaluate/`  running an expression and surviving the result
 * - `input/`     key chords, pointer paths, touch gestures
 * - `perf/`      web vitals from the browser's own observers
 * - `snapshot/`  the whole page flattened, frames and shadow
 *                content included, and queries over it
 * - `sourcemap/` where generated code was authored
 * - `styles/`    computed style curation and cascade tracing
 * - `target/`    naming an element by role and accessible name
 * - `telemetry/` console, network, dialogs, downloads, lifecycle
 * - `wait/`      conditions worth waiting for
 *
 * Every subdomain but `session` is pure and capture-agnostic:
 * serializable data in, answers out. That is what lets the same
 * analysis run against a live page, a stored capture, or one
 * taken by something that is not this library at all. Only
 * `session` and `browser` reach for puppeteer, so importing an
 * analysis module never starts a browser.
 */

export {
	type AxNode,
	type AxProperties,
	normalizeAxTree,
	type RawAxNode,
	renderAxOutline,
} from "./a11y/index.js";
export {
	BrowserLaunchFailed,
	closeBrowser,
	killBrowserSync,
} from "./browser.js";
export {
	type MermaidRender,
	MermaidRenderError,
	renderMermaid,
} from "./mermaid.js";
export {
	AuthSetupNeeded,
	cleanupSessionBundles,
	type PageBundle,
	readPage,
	reapAbandonedBundles,
} from "./reader.js";
export { type SearchResult, webSearch } from "./search.js";
export {
	type ActResult,
	BrowserSession,
	type Observation,
	type PageAction,
} from "./session.js";
export {
	resolveTarget,
	type Target as SemanticTarget,
	type TargetResolution,
} from "./target/index.js";
