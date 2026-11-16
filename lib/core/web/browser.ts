/**
 * Browser lifecycle: launch Chrome once, reuse across tool calls.
 * Pure Chrome management: no cookie knowledge.
 *
 * The singleton lives on globalThis rather than in a module
 * variable. Pi loads each extension as its own module instance,
 * so a module-level singleton would give web search, mermaid and
 * the browser tool a browser each, all racing to launch Chrome
 * against the same per-pid profile; the first wins the profile
 * lock and the rest fail to launch. A process-global instance,
 * plus a shared in-flight launch promise, means one browser and
 * one profile no matter how many extensions reach for it.
 *
 * This module is the one callers import. Its parts live in
 * browser/, each kept apart for its own reason to change:
 *
 * - failure.ts: what a launch that never came up says.
 * - reaping.ts: killing a Chrome tree and reaping orphans.
 * - idle.ts: when an idle browser closes.
 * - profile.ts: this process's profile and its owner record.
 * - loop.ts: whether the browser holds the event loop.
 * - launch.ts: starting Chrome, and joining another process's.
 * - shared.ts: the one shared browser's lifetime.
 * - tabs.ts: the tabs callers open in it.
 */

export {
	BrowserLaunchFailed,
	classifyLaunchError,
	formatLaunchFailure,
} from "./browser/failure.ts";
export {
	createIdleCloser,
	shouldCloseWhenIdle,
	shouldForceKill,
} from "./browser/idle.ts";
export { connectShared } from "./browser/launch.ts";
export { holdEventLoop, releaseEventLoop } from "./browser/loop.ts";
export { isPidAlive } from "./browser/profile.ts";
export {
	killPidGroup,
	killTree,
	reapOrphans,
} from "./browser/reaping.ts";
export {
	closeBrowser,
	getBrowser,
	killBrowserSync,
} from "./browser/shared.ts";
export {
	holdWhile,
	newContextPage,
	newPage,
	withTab,
} from "./browser/tabs.ts";
export { namesProfile } from "./procs.ts";
