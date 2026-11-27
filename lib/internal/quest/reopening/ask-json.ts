/**
 * Asking a program for what it prints as JSON, for the timer that notes
 * which windows here are joined to a session elsewhere
 * (scripts/windows-elsewhere.ts), which asks each kitty and the mycelium
 * node every minute.
 *
 * No answer leaves that note as it stands, which is right for a program
 * that is missing, not running or slow: the windows it names may well
 * still be there. An answer that came but was lost is another matter.
 * On 27 November `mycelium sessions` printed 1,532,857 bytes on optimus,
 * past Node's 1 MB default, and the silent catch took that for a node not
 * running, so the note was never written and a reboot offered no windows
 * back. So the cap sits far above any session list, and an answer too
 * long or not JSON is said on stderr, where the timer's journal keeps it.
 */

import { execFileSync } from "node:child_process";

/** How long one kitty or the node may take to answer. */
const ASK_MS = 5000;

/**
 * How much a program may print. Node's own cap is 1 MB, and the node's
 * session list ran to 1.5 MB on 27 November.
 */
const ASK_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * The answer a program prints as JSON, or undefined when it gives none:
 * when it is missing, fails, is slow, prints more than the cap or prints
 * something that isn't JSON. The last two are said on stderr, naming the
 * program, since they mean an answer came and was lost.
 */
export function askJson(program: string, args: readonly string[]): unknown {
	let out: string;
	try {
		out = execFileSync(program, [...args], {
			encoding: "utf8",
			timeout: ASK_MS,
			maxBuffer: ASK_OUTPUT_BYTES,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (error) {
		// Past the cap it answered but the answer was cut off, which no
		// caller should take for silence, so it's said.
		if (errorCode(error) === "ENOBUFS") {
			process.stderr.write(
				`${program} printed more than ${ASK_OUTPUT_BYTES / 1024 / 1024} MiB, so its answer was dropped (ENOBUFS)\n`,
			);
		}
		// Otherwise it isn't installed, isn't running or was slow: nothing
		// from it this time, and nothing worth saying every minute.
		return undefined;
	}
	try {
		return JSON.parse(out);
	} catch (error) {
		// It answered, but not in JSON, so its answer is said as lost
		// rather than taken for silence.
		const cause = error instanceof Error ? error.message : String(error);
		process.stderr.write(
			`${program} printed something that isn't JSON: ${cause}\n`,
		);
		return undefined;
	}
}

/** The system error's code a failed run carries, such as ENOENT or ENOBUFS. */
function errorCode(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}
