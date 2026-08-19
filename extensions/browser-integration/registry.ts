/**
 * Named browser sessions, shared by every browser tool.
 *
 * A session is a live browser under a caller-chosen name. It
 * disposes after an idle stretch and again at shutdown, so a
 * conversation that wanders off does not leak a browser.
 *
 * Idle is measured from the last thing the session did, not from
 * when the last call started, so a long-running call is never
 * reaped underneath itself.
 */

import { closeBrowser } from "@jitsusama/agentic-harness.core/web/browser";
import {
	BrowserSession,
	type SessionOptions,
} from "@jitsusama/agentic-harness.core/web/session";
import { dataDir } from "../../lib/internal/paths.js";

/**
 * Where this extension's baselines already live on disk.
 *
 * Passed explicitly rather than left to the library's own default,
 * so moving the browser engine out to agentic-harness.core did not
 * orphan comparison baselines a user already has on disk under
 * pi's own XDG path.
 */
const DATA_ROOT = dataDir("browser-integration");

/**
 * Close a session after this long without use.
 *
 * Generous on purpose. The thing on the other end of these tools
 * spends most of its time reading, editing and thinking between
 * browser calls, and half an hour of that is an ordinary stretch.
 * At five minutes a session would vanish mid-task, taking its
 * navigation, storage, emulation and network shaping with it, and
 * the next call would look like a mistake by the caller rather
 * than a timer that fired.
 *
 * The cost of waiting longer is a warm Chrome holding memory. It
 * is not a process that refuses to exit: the browser's handles are
 * released once it launches, so an idle session never keeps a
 * finished script alive, and shutdown disposes everything anyway.
 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How many closed sessions to remember, to explain their absence. */
const REMEMBERED_CLOSURES = 16;

/** The session a call lands in when the caller names none. */
export const DEFAULT_SESSION = "default";

interface Held {
	/** Held as a promise so concurrent calls share one open. */
	opening: Promise<BrowserSession>;
	idle?: ReturnType<typeof setTimeout>;
}

/** Why a session that is not open is not open. */
export type Departure = "idle" | "closed";

/** The live sessions, keyed by caller-chosen name. */
export interface SessionRegistry {
	/** Whether a session is currently open under this name. */
	has(name: string): boolean;
	/** Every session open right now, in the order they opened. */
	open(): readonly string[];
	/**
	 * How a session by this name went away, when one did.
	 *
	 * Lets a refusal say what happened instead of implying the
	 * caller invented the name.
	 */
	departureOf(name: string): Departure | undefined;
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
	// Bounded, so a long conversation that opens many sessions does
	// not accumulate names for ever.
	const departed = new Map<string, Departure>();

	const remember = (name: string, how: Departure): void => {
		departed.delete(name);
		departed.set(name, how);
		if (departed.size > REMEMBERED_CLOSURES) {
			const oldest = departed.keys().next();
			if (!oldest.done) departed.delete(oldest.value);
		}
	};

	const touch = (name: string, held: Held): void => {
		clearTimeout(held.idle);
		held.idle = setTimeout(() => {
			// Idle means the session has done nothing, not that a call
			// started a while ago. The timer used to be set only when a
			// call began, so anything running longer than the timeout
			// (a health sweep across four widths, an uncapped wait) had
			// its browser closed out from under it, and the cleanup
			// that followed then failed against a dead session and
			// masked whichever error actually happened.
			void held.opening
				.then(async (session) => {
					const quietFor = Date.now() - session.lastUsedAt;
					if (quietFor < IDLE_TIMEOUT_MS) {
						touch(name, held);
						return;
					}
					sessions.delete(name);
					remember(name, "idle");
					await session.close();
				})
				.catch(() => {
					// A session that never opened, or one already closed:
					// either way there is nothing left to reap.
					sessions.delete(name);
				});
		}, IDLE_TIMEOUT_MS);
		held.idle.unref?.();
	};

	return {
		has(name) {
			return sessions.has(name);
		},

		open() {
			return [...sessions.keys()];
		},

		departureOf(name) {
			return departed.get(name);
		},

		async acquire(name, options) {
			const existing = sessions.get(name);
			if (existing) {
				touch(name, existing);
				return existing.opening;
			}
			const held: Held = {
				opening: BrowserSession.open(name, {
					dataRoot: DATA_ROOT,
					...options,
				}),
			};
			departed.delete(name);
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
			remember(name, "closed");
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
