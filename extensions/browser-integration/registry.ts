/**
 * Named browser sessions, shared by every browser tool.
 *
 * A session is a live browser under a caller-chosen name. It
 * disposes after an idle stretch and again at shutdown, so a
 * conversation that wanders off does not leak a browser.
 */

import { closeBrowser } from "../../lib/web/browser.js";
import { BrowserSession, type SessionOptions } from "../../lib/web/session.js";

/** Close a session after this long without use. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** The session a call lands in when the caller names none. */
export const DEFAULT_SESSION = "default";

interface Held {
	/** Held as a promise so concurrent calls share one open. */
	opening: Promise<BrowserSession>;
	idle?: ReturnType<typeof setTimeout>;
}

/** The live sessions, keyed by caller-chosen name. */
export interface SessionRegistry {
	/** Whether a session is currently open under this name. */
	has(name: string): boolean;
	/**
	 * The named session, opening one when none is live. Options
	 * apply only to an open; an existing session keeps the ones
	 * it was opened with.
	 */
	acquire(name: string, options?: SessionOptions): Promise<BrowserSession>;
	/** Close one session; false when none was open. */
	close(name: string): Promise<boolean>;
	/** Close every session and the shared browser. */
	disposeAll(): Promise<void>;
}

/** Build a registry of idle-disposing named sessions. */
export function createSessionRegistry(): SessionRegistry {
	const sessions = new Map<string, Held>();

	const touch = (name: string, held: Held): void => {
		clearTimeout(held.idle);
		held.idle = setTimeout(() => {
			sessions.delete(name);
			void held.opening.then((session) => session.close()).catch(() => {});
		}, IDLE_TIMEOUT_MS);
		held.idle.unref?.();
	};

	return {
		has(name) {
			return sessions.has(name);
		},

		async acquire(name, options) {
			const existing = sessions.get(name);
			if (existing) {
				touch(name, existing);
				return existing.opening;
			}
			const held: Held = { opening: BrowserSession.open(name, options) };
			sessions.set(name, held);
			touch(name, held);
			try {
				return await held.opening;
			} catch (err) {
				// A session that never opened must not linger in the map.
				clearTimeout(held.idle);
				sessions.delete(name);
				throw err;
			}
		},

		async close(name) {
			const held = sessions.get(name);
			if (!held) return false;
			clearTimeout(held.idle);
			sessions.delete(name);
			await held.opening.then((session) => session.close()).catch(() => {});
			return true;
		},

		async disposeAll() {
			const held = [...sessions.values()];
			sessions.clear();
			for (const one of held) {
				clearTimeout(one.idle);
				await one.opening.then((session) => session.close()).catch(() => {});
			}
			await closeBrowser();
		},
	};
}
