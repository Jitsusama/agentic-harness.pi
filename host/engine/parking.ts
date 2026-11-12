/**
 * Parking an idle conversation and waking it: the host stops it as a
 * host stop does, keeping its hold, and watches the wake file each
 * conversation is told of in MYCELIUM_WAKE, as a holder watches plain
 * pi's, until it is written, a viewer types or a window opens on it.
 * A wake through the file that is refused is kept beside it, with the
 * message that asked, for the mesh to say (refused-wake.ts), until the
 * conversation next runs.
 */
import {
	existsSync,
	type FSWatcher,
	mkdirSync,
	readFileSync,
	rmSync,
	watch,
} from "node:fs";
import { join } from "node:path";
import {
	clearRefusedWake,
	wakeAskedBy,
	writeRefusedWake,
} from "../../lib/internal/session/refused-wake.ts";

/** The file inside a conversation's folder that, once written, wakes it from a park. */
const WAKE_FILE = "wake";

/** What a wake file holds, or nothing where it went before it was read. */
function readWritten(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		// Gone between its event and this read: a wake that names no message.
		return "";
	}
}

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
	/**
	 * It resumed: stop watching for its wake, and forget a wake refused it
	 * as it started, after `running` cleared the last.
	 */
	unwatch(sessionId: string): void;
	/** It was closed: stop watching, and forget a wake refused it. */
	closed(sessionId: string): void;
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
	/** It parked: said before its wake is watched, so any wake comes after. */
	readonly parked?: (sessionId: string) => void;
}): Parking {
	const { stateDir, report } = options;
	// Parked conversations, each watching its wake file until it wakes or is closed.
	const sleepers = new Map<string, FSWatcher>();
	// Conversations parking now.
	const settling = new Map<string, Settling>();
	const folderOf = (sessionId: string) => join(stateDir, sessionId);
	const wakeFile = (sessionId: string) => join(folderOf(sessionId), WAKE_FILE);

	function stopWatching(sessionId: string): void {
		sleepers.get(sessionId)?.close();
		sleepers.delete(sessionId);
	}

	// Once it runs or is closed, no refusal of a wake says anything true.
	function forget(sessionId: string): void {
		stopWatching(sessionId);
		clearRefusedWake(wakeFile(sessionId));
	}

	function watchWake(sessionId: string): void {
		stopWatching(sessionId);
		const file = wakeFile(sessionId);
		mkdirSync(folderOf(sessionId), { recursive: true });
		const woken = () => {
			const watching = sleepers.get(sessionId);
			if (!watching || !existsSync(file)) return;
			const messageId = wakeAskedBy(readWritten(file));
			rmSync(file, { force: true });
			wake(sessionId).catch((error: unknown) => {
				// Reported as it failed; kept for the mesh to say, until the next
				// message writes the file again or the conversation runs. One
				// settling once this watch is gone, at a close or another park,
				// would outlive what cleared it.
				if (sleepers.get(sessionId) !== watching) return;
				try {
					writeRefusedWake(file, {
						...(messageId === undefined ? {} : { messageId }),
						reason: error instanceof Error ? error.message : String(error),
						at: new Date().toISOString(),
					});
				} catch (unkept) {
					report(unkept);
				}
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
			options.parked?.(sessionId);
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
			clearRefusedWake(wakeFile(sessionId));
		},
		park(sessionId) {
			const asked: Settling["asked"] = [];
			const done = park(sessionId, asked);
			settling.set(sessionId, { done, asked });
			return done;
		},
		wake,
		settled: (sessionId) => settling.get(sessionId)?.done ?? Promise.resolve(),
		unwatch: forget,
		closed: forget,
	};
}
