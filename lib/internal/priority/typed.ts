/**
 * Which pi is running a turn a person typed, said as a file of its own
 * pid in `$XDG_RUNTIME_DIR/pi/typed`, so the machine's traffic shaper can
 * send that turn's request ahead of the rest.
 *
 * Every call sends the whole conversation again, and on 30 October thirty
 * sessions doing so filled an upload of about 1.4 MB/s: a turn Joel typed
 * waited behind every autonomous session's request and hit pi's five
 * minute timeout twice. The shaper puts every pi with no file here in its
 * bulk class, and leaves one with a file at best effort, ahead of them.
 * A pid can't set its own socket marks from Node, so the file is the
 * whole contract; one whose pid has gone is ignored by the shaper.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The folder the files are in, or nothing with no runtime folder. */
export function typedDir(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const runtime = env.XDG_RUNTIME_DIR;
	return runtime ? join(runtime, "pi", "typed") : undefined;
}

/**
 * Follows one pi's turns: a turn is typed from the moment a person's
 * input arrives until the turn it started ends, and a person's input
 * that arrives while a turn runs, to follow it, keeps the file for the
 * next turn. Errors writing are dropped: the shaper then treats the turn
 * as bulk, which is how it was before.
 */
export function typedTurns(dir: string | undefined, pid = process.pid) {
	const file = dir ? join(dir, String(pid)) : undefined;
	let typedAt = 0;
	let turnAt = 0;
	const mark = () => {
		if (!file || !dir) return;
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, `${new Date().toISOString()}\n`);
		} catch {
			// A shaper that can't see the file sends this turn as bulk.
		}
	};
	const unmark = () => {
		if (!file) return;
		try {
			rmSync(file, { force: true });
		} catch {
			// One left behind is the shaper's to ignore once its pid goes.
		}
	};
	return {
		/** A person's input arrived. */
		typed(now = Date.now()) {
			typedAt = now;
			mark();
		},
		/** A turn began. */
		began(now = Date.now()) {
			turnAt = now;
		},
		/** A turn ended; the file stays when a person typed during it. */
		ended() {
			if (typedAt <= turnAt) unmark();
		},
		/** The session ends. */
		stop: unmark,
	};
}
