/**
 * Parking an idle conversation and waking it: the host stops it as a
 * host stop does, keeping its hold, and watches the wake file each
 * conversation is told of in MYCELIUM_WAKE, as a holder watches plain
 * pi's, until it is written, a viewer types or a window opens on it.
 */
import { existsSync, type FSWatcher, mkdirSync, rmSync, watch } from "node:fs";
import { join } from "node:path";

/** The file inside a conversation's folder that, once written, wakes it from a park. */
const WAKE_FILE = "wake";

/** Why a parked conversation's session ended, as its stop says. */
export const PARKED = "parked while idle";

/** What parks and wakes the engine's conversations. */
export interface Parking {
	/** Where a sender wakes this conversation once it parks. */
	wakeFile(sessionId: string): string;
	/** It runs now: a wake left from an earlier park would wake its next at once. */
	running(sessionId: string): void;
	/** Park it, then watch for its wake; a wake asked meanwhile wakes it once parked. */
	park(sessionId: string): Promise<void>;
	/**
	 * It is asked for: wake it, or once its park settles. Settles once the
	 * wake has, rejecting with why it failed, so whoever asked can say so
	 * and ask again.
	 */
	wake(sessionId: string): Promise<void>;
	/** Once a park of it under way has settled, at once when none is. */
	settled(sessionId: string): Promise<void>;
	/** Stop watching for its wake, as it resumes or is closed. */
	unwatch(sessionId: string): void;
}

/** A park under way: when it settles, and the wakes asked of it meanwhile. */
interface Settling {
	readonly done: Promise<void>;
	readonly asked: { resolve(): void; reject(error: unknown): void }[];
}

/**
 * Park conversations under `stateDir`, each in its own folder there.
 * `stop` ends its session as a host stop does; `asking` is what wakes
 * one, the service's wake once it listens.
 */
export function parking(options: {
	readonly stateDir: string;
	readonly stop: (sessionId: string, why: string) => Promise<void>;
	readonly asking: () => ((sessionId: string) => Promise<void>) | undefined;
	readonly report: (error: unknown) => void;
}): Parking {
	const { stateDir, report } = options;
	// Parked conversations, each watching its wake file until it wakes or is closed.
	const sleepers = new Map<string, FSWatcher>();
	// Conversations parking now.
	const settling = new Map<string, Settling>();
	const folderOf = (sessionId: string) => join(stateDir, sessionId);
	const wakeFile = (sessionId: string) => join(folderOf(sessionId), WAKE_FILE);

	function unwatch(sessionId: string): void {
		sleepers.get(sessionId)?.close();
		sleepers.delete(sessionId);
	}

	function watchWake(sessionId: string): void {
		unwatch(sessionId);
		const file = wakeFile(sessionId);
		mkdirSync(folderOf(sessionId), { recursive: true });
		const woken = () => {
			if (!sleepers.has(sessionId) || !existsSync(file)) return;
			rmSync(file, { force: true });
			wake(sessionId).catch(() => {
				// Reported as it failed; the next message writes the file again.
			});
		};
		const watcher = watch(folderOf(sessionId), (_, name) => {
			if (name === WAKE_FILE) woken();
		});
		watcher.unref();
		watcher.on("error", report);
		sleepers.set(sessionId, watcher);
		// One written between its park and this watch.
		woken();
	}

	function wake(sessionId: string): Promise<void> {
		const parked = settling.get(sessionId);
		if (parked)
			return new Promise((resolve, reject) => {
				parked.asked.push({ resolve, reject });
			});
		const asking = options.asking();
		if (!asking) {
			const error = new Error(
				`Nothing can wake parked conversation ${sessionId}`,
			);
			report(error);
			return Promise.reject(error);
		}
		return asking(sessionId).catch((error: unknown) => {
			report(error);
			throw error;
		});
	}

	async function park(sessionId: string, asked: Settling["asked"]) {
		try {
			await options.stop(sessionId, PARKED);
			watchWake(sessionId);
		} catch (error) {
			// Stopped but unwatched, only a viewer or an attach wakes it; not
			// stopped, it stays held as a failed close leaves it.
			report(error);
		} finally {
			settling.delete(sessionId);
		}
		// A key or a message while it parked asked for it before it could wake.
		if (asked.length > 0)
			wake(sessionId).then(
				() => {
					for (const one of asked) one.resolve();
				},
				(error: unknown) => {
					for (const one of asked) one.reject(error);
				},
			);
	}

	return {
		wakeFile,
		running(sessionId) {
			rmSync(wakeFile(sessionId), { force: true });
		},
		park(sessionId) {
			const asked: Settling["asked"] = [];
			const done = park(sessionId, asked);
			settling.set(sessionId, { done, asked });
			return done;
		},
		wake,
		settled: (sessionId) => settling.get(sessionId)?.done ?? Promise.resolve(),
		unwatch,
	};
}
