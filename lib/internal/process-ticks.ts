/**
 * A process's start as the kernel counts it: clock ticks since boot.
 *
 * Core's process module names a process by its start in wall-clock
 * milliseconds, the boot time `/proc/stat` gives plus these ticks. The
 * kernel moves that boot time whenever the wall clock is corrected,
 * and every suspend nudges it: after 100 suspends on 26 October it had
 * moved four seconds, past core's two-second tolerance, and every peer
 * on the mesh read as a new process wearing an old pid. The ticks
 * never move for a process, so within one boot they name it exactly.
 */

import { readFile } from "node:fs/promises";

/** A process's start in ticks since boot; nothing when it cannot be read. */
export type StartTicks = (pid: number) => Promise<number | undefined>;

/** Index of the start time (field 22) after the command's closing parenthesis. */
const START_FIELD = 19;

/** A process's start in ticks, read from `/proc/<pid>/stat`. */
export const startTicksFromProc: StartTicks = async (pid) => {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		// The command name sits in parentheses and may hold anything,
		// so the fields are counted from the last closing one.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(fields[START_FIELD]);
		return Number.isSafeInteger(ticks) ? ticks : undefined;
	} catch {
		// No such process, or no /proc, as on macOS: there is nothing to
		// name it by, and the caller falls back on core's account.
		return undefined;
	}
};
