/**
 * The session's store, made once and shared.
 *
 * The library is stateless on purpose, so the session's lifetime
 * is owned here: created on first use, pointed at this process's
 * directory, emptied at shutdown. Every family that cites a handle
 * and the one tool that queries them all resolve to the same
 * directory, so they all see the same payloads.
 */

import {
	createResultStore,
	ensureSessionResultDir,
	type ResultStore,
	SESSION_QUOTA_BYTES,
} from "../../lib/result/index.js";

let store: ResultStore | undefined;

/** This session's store, created on first use. */
export function sessionStore(): ResultStore {
	if (!store) {
		store = createResultStore({
			dir: ensureSessionResultDir(),
			maxBytes: SESSION_QUOTA_BYTES,
		});
	}
	return store;
}

/** Drop the cached store so the next call rebuilds it. */
export function forgetSessionStore(): void {
	store = undefined;
}
