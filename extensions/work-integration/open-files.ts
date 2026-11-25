/**
 * What lsof lists of this account's processes' files, for the sweep's
 * reading of which trees are in use on a machine with no `/proc`, as
 * macOS has none.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Runs a program off the event loop and reads its output whole. */
export type RunProgram = (
	file: string,
	args: readonly string[],
	options: {
		encoding: "utf8";
		maxBuffer: number;
		timeout: number;
		killSignal: NodeJS.Signals;
	},
) => Promise<{ stdout: string; stderr: string }>;

/** Where macOS keeps lsof, which a sweep's fixed PATH may not name. */
const LSOF = "/usr/sbin/lsof";

/**
 * How long lsof may list for. It runs under a tree's record lock while a
 * take judges that tree, where an asking session waits ten seconds before
 * it gives up and takes a lock thirty seconds old as stale; a Mac's 594
 * processes listed in about 2.5 s on 24 November.
 */
export const LSOF_LIMIT_MS = 5 * 1000;

/** The most lsof may write, far past the 66,418 lines a busy Mac gave. */
const LSOF_OUTPUT_MOST = 256 * 1024 * 1024;

/** Who is asking: the account whose processes are listed, and its own. */
export interface Lister {
	uid: number | undefined;
	pid: number;
}

/**
 * What lsof lists of `lister`'s account's processes, as fields a line:
 * each process's number, then its working folder, program and open files
 * by name. Another account's processes are left out, as `/proc` refuses
 * their links to this one. Nothing when lsof fails, runs past its time,
 * writes past its bound or warns of anything, or when the listing leaves
 * out the asking process itself, which shares the account and so is
 * always there in a whole one: each means a holder may have been missed.
 */
export async function listedOpenFiles(
	run: RunProgram = promisify(execFile),
	lister: Lister = { uid: process.getuid?.(), pid: process.pid },
): Promise<string | undefined> {
	if (lister.uid === undefined) return undefined;
	let listed: { stdout: string; stderr: string };
	try {
		listed = await run(
			LSOF,
			["-n", "-P", "-F", "n", "-u", String(lister.uid)],
			{
				encoding: "utf8",
				maxBuffer: LSOF_OUTPUT_MOST,
				timeout: LSOF_LIMIT_MS,
				// A listing past its time is ended outright rather than
				// asked to stop, so the take waiting on it goes on.
				killSignal: "SIGKILL",
			},
		);
	} catch {
		// Failed, stuck or too long: a reading that can't say, never one
		// that calls every tree free.
		return undefined;
	}
	if (listed.stderr.trim() !== "") return undefined;
	const self = `p${lister.pid}`;
	const whole = listed.stdout.split("\n").some((line) => line === self);
	return whole ? listed.stdout : undefined;
}
