/**
 * Whether the machine has the memory to start a council's reviewers.
 *
 * A council starts several pis at once, each holding a pi's worth of
 * memory for minutes. Rounds used to start a fixed three minutes apart
 * whatever the machine had to spare, so on 24 November one waited about
 * 30 minutes behind ten others on a machine with room for all of them,
 * and on a starved one three minutes was no guard at all. The rule now
 * is room alone (1OGSE7, 24 November): a round starts while the share
 * of the last minute every task spent stalled on memory, the kernel's
 * `full avg60`, is under 10.
 */

import { readFile } from "node:fs/promises";

/** The kernel's memory pressure, where Linux keeps it. */
export const MEMORY_PRESSURE_FILE = "/proc/pressure/memory";

/** The `full avg60` at and past which a round waits for room. */
export const FULL_AVG60_AT_MOST = 10;

const FULL_AVG60 = /^full\b.*\bavg60=(\d+(?:\.\d+)?)/m;

/**
 * What keeps a round from starting now, said for its answer, or nothing
 * when the machine has room. A machine that keeps no pressure, as a Mac,
 * or one whose reading can't be had, has room: nothing says otherwise,
 * and a round held on a reading that never comes would never start.
 */
export async function memoryShort(
	read: () => Promise<string> = () => readFile(MEMORY_PRESSURE_FILE, "utf8"),
): Promise<string | undefined> {
	let text: string;
	try {
		text = await read();
	} catch {
		// No pressure file, as on a Mac or an old kernel: nothing says short.
		return undefined;
	}
	const said = FULL_AVG60.exec(text)?.[1];
	if (said === undefined) return undefined;
	const avg60 = Number(said);
	return avg60 < FULL_AVG60_AT_MOST
		? undefined
		: `memory full avg60 was ${avg60}, at or past ${FULL_AVG60_AT_MOST}`;
}
