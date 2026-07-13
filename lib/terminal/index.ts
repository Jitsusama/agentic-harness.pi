/**
 * Public surface of the terminal library.
 *
 * Pluggable launchers for new tabs, panes and windows. The
 * quest extension uses it for `spawn-tab`/`spawn-pane`/
 * `spawn-window`; other extensions can pick the same
 * driver or register their own.
 */

export {
	clearTerminalDrivers,
	registerBuiltinTerminalDrivers,
	registerTerminalDriver,
	unregisterTerminalDriver,
} from "./register.js";
export {
	getLivenessProvider,
	getTerminalDriver,
	identifyCurrentTerminal,
	listTerminalDrivers,
	resolveDriver,
	spawnTerminal,
} from "./resolve.js";
export type {
	TerminalDriver,
	TerminalLayout,
	TerminalLivenessCapability,
	TerminalProbe,
	TerminalRequest,
	TerminalSessionHandle,
} from "./types.js";
export { terminalHandleKey } from "./types.js";
