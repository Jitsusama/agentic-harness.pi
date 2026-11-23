/**
 * What a session's last arrival said, kept in its quest's scratch.
 *
 * mycelium starts `pi-carry arrive` in a held session, whose output goes
 * to that session's terminal and nowhere else. When an arrival failed
 * before pi started, the hold ended and took its output with it: on
 * 23 November a carried session came to stand nowhere, and nothing on
 * either machine said why. So each arrival writes every line it said,
 * and whether it came whole, to `arrivals/<session>.json` in the quest's
 * scratch, written over by the next arrival of the same session.
 */

import { join } from "node:path";
import { writeWhole } from "../write-whole.ts";
import type { ArrivalLine } from "./arrive.ts";

/** The folder of a quest's scratch the arrival records go in. */
export const ARRIVALS = "arrivals";

/** One arrival, as its record keeps it. */
export interface ArrivalRecord {
	readonly at: string;
	readonly from: string;
	readonly whole: boolean;
	readonly said: readonly ArrivalLine[];
}

/** The file `session`'s last arrival is recorded in. */
export function arrivalRecordOf(scratch: string, session: string): string {
	return join(scratch, ARRIVALS, `${session}.json`);
}

/** Records `session`'s arrival in `scratch`, over any before it. */
export function recordArrival(
	scratch: string,
	session: string,
	record: ArrivalRecord,
): void {
	writeWhole(
		arrivalRecordOf(scratch, session),
		`${JSON.stringify(record, null, 2)}\n`,
	);
}
