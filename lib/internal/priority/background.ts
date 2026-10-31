/**
 * Which pi may yield the CPU to what the person is using, said as a file
 * of its own pid in `$XDG_RUNTIME_DIR/pi/background`, so the machine's
 * jobs-sorter can give its scope a low CPU weight.
 *
 * On 30 October, rounds at weights 100, 25 and 10 for about 26 pi
 * windows nobody typed in showed a 60 Hz app's worst frame under load
 * about 40% lower at 10. The typed marker (typed.ts) can't say which
 * windows those are: it holds only while a turn a person typed runs, so
 * a window the person is writing in between turns reads as untyped, and
 * at weight 10 their keys would wait. So this file says the opposite, and
 * only while it is sure: the pi runs a turn nobody typed, no key has
 * reached it for a minute, and its editor holds nothing. A key removes it
 * before anything else happens. A pi that never writes it, on an older
 * install, in RPC or print mode, or gone, stays at the full weight.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long since a key reached a pi before it may yield. */
export const QUIET_MS = 60_000;

/** The folder the files are in, or nothing with no runtime folder. */
export function backgroundDir(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const runtime = env.XDG_RUNTIME_DIR;
	return runtime ? join(runtime, "pi", "background") : undefined;
}

/** What a pi's background file is judged from. */
export interface BackgroundSigns {
	/** The text in its editor now. */
	readonly editorText: () => string;
	/** Whether a turn a person typed holds it now (typed.ts). */
	readonly typed: () => boolean;
	readonly pid?: number;
	readonly quietMs?: number;
	/** When it started; counted as a key, so a new window starts present. */
	readonly now?: number;
}

/**
 * Follows one pi in the terminal: its keys, its turns and its editor.
 * Call settle often during a turn, so the file appears once the pi has
 * been quiet long enough. Errors writing are dropped: with no file the
 * pi keeps its full weight, which is how it was before.
 */
export function backgroundTurns(
	dir: string | undefined,
	signs: BackgroundSigns,
) {
	const file = dir ? join(dir, String(signs.pid ?? process.pid)) : undefined;
	const quietMs = signs.quietMs ?? QUIET_MS;
	let keyAt = signs.now ?? Date.now();
	let inTurn = false;
	let marked = false;
	const mark = () => {
		if (marked || !file || !dir) return;
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, `${new Date().toISOString()}\n`);
			marked = true;
		} catch {
			// With no file the sorter leaves this pi at its full weight.
		}
	};
	const unmark = () => {
		if (!marked || !file) return;
		marked = false;
		try {
			rmSync(file, { force: true });
		} catch {
			// One left behind is the sorter's to ignore once its pid goes.
		}
	};
	const editorEmpty = () => {
		try {
			return signs.editorText().trim() === "";
		} catch {
			// An editor that can't be read may hold the person's words.
			return false;
		}
	};
	const settle = (now = Date.now()) => {
		const yields =
			inTurn && !signs.typed() && now - keyAt >= quietMs && editorEmpty();
		if (yields) mark();
		else unmark();
	};
	return {
		/** A key reached this pi: it is the person's at once. */
		key(now = Date.now()) {
			keyAt = now;
			unmark();
		},
		/** A turn began. */
		began(now = Date.now()) {
			inTurn = true;
			settle(now);
		},
		/** Looks again at whether the pi may yield. */
		settle,
		/** A turn ended. */
		ended() {
			inTurn = false;
			unmark();
		},
		/** The session ends. */
		stop() {
			inTurn = false;
			unmark();
		},
	};
}
