/**
 * What the person said to sessions from outside their windows, and how
 * each stands, as the node keeps it: `mycelium said`, a JSON line a
 * thing said, oldest first (KP0L6A's surfaces table, 24 November). A
 * session reads it so the window he is in shows whether what he said
 * was taken up, is being worked on or was answered, as the launcher's
 * talk does.
 */

import { isRecord } from "../internal/record.ts";
import { oneLine } from "./one-line.ts";

/** The command line that lists what the person said. */
export const SAID_COMMAND = ["said"] as const;

/** How one thing he said stands. */
export type SaidStanding =
	| "answered"
	| "working"
	| "not taken up"
	| "put in its prompt";

/** One thing the person said to a session. */
export interface SaidTo {
	readonly address: string;
	readonly machine?: string;
	/** When he said it, as an ISO time. */
	readonly at: string;
	/** What he said, on one line. */
	readonly text: string;
	readonly standing: SaidStanding;
}

/**
 * What a listing's lines say he said since `since`, newest first, at most
 * `most`; a line that is no such thing is skipped.
 */
export function saidFrom(
	listing: string,
	since: number,
	most: number,
): SaidTo[] {
	return listing
		.split("\n")
		.flatMap((line) => {
			const said = saidOf(line);
			return said && Date.parse(said.at) >= since ? [said] : [];
		})
		.sort((one, other) => Date.parse(other.at) - Date.parse(one.at))
		.slice(0, most);
}

/** The thing said one line of the listing holds, or none. */
function saidOf(line: string): SaidTo | undefined {
	if (line.trim() === "") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		// A line torn or not JSON is nothing said: the rest still read.
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const { address, at, text, machine } = value;
	if (typeof address !== "string" || address === "") return undefined;
	if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
		return undefined;
	}
	return {
		address: oneLine(address),
		...(typeof machine === "string" && machine !== ""
			? { machine: oneLine(machine) }
			: {}),
		at,
		text: typeof text === "string" ? oneLine(text) : "",
		standing: standingOf(value),
	};
}

/** How a thing said stands, by what the node recorded of it. */
function standingOf(said: Record<string, unknown>): SaidStanding {
	if (said.act === "fill") return "put in its prompt";
	if (typeof said.answered === "string") return "answered";
	if (typeof said.taken_up === "string") return "working";
	return "not taken up";
}
