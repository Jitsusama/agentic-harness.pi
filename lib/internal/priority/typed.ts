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
 *
 * A host follows each conversation's turns apart, and the file, being the
 * process's, stays while a turn a person typed holds any of them
 * (pid-mark.ts).
 */

import { join } from "node:path";
import { followPidMark } from "./pid-mark.ts";

/**
 * Said on `pi.events` as the mesh delivers the person's own words from
 * the launcher (isPersonsTalk, lib/mesh/steer.ts). They arrive as an
 * extension's message, not typed input, yet the person waits on the turn
 * they start as on one typed. `intoRun` says they went into a run under
 * way rather than starting one.
 */
export const PERSON_TALKED = "priority:person-talked:v1";

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
	const file = dir
		? followPidMark(dir, join(dir, String(pid)), "any")
		: undefined;
	let typedAt = 0;
	let turnAt = 0;
	let held = false;
	const mark = () => {
		held = true;
		file?.hold(true);
	};
	const unmark = () => {
		held = false;
		file?.hold(false);
	};
	return {
		/** A person's input arrived. */
		typed(now = Date.now()) {
			typedAt = now;
			mark();
		},
		/**
		 * The person's words were read into the run under way, which pi
		 * does for a steer and a follow-up alike: the run is theirs to its
		 * end, and the next is not.
		 */
		steeredIn() {
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
		/** Whether a turn a person typed holds this pi now. */
		held: () => held,
		/** The session ends. */
		stop() {
			held = false;
			file?.leave();
		},
	};
}
