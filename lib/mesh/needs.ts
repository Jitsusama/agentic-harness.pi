/**
 * What every cell on the mesh waits on the person for, as the map and
 * the CLI read it: `mycelium cells --standing needs-you -o json`, a cell
 * a line (KP0L6A's surfaces table, 24 November). A pi session reads the
 * same, so Joel sees in the window he is in what the launcher shows him
 * (Joel, 24 November: "any interface i'm in should be directly engagable
 * to a meaningful level").
 */

import { oneLine } from "./one-line.ts";

/** The command line that lists every cell needing the person. */
export const NEEDS_COMMAND = [
	"cells",
	"--standing",
	"needs-you",
	"-o",
	"json",
] as const;

/** One cell waiting on the person. */
export interface Need {
	/** The cell's address. */
	readonly name: string;
	readonly title: string;
	/** What it asks of him, on one line. */
	readonly asks: string;
	/** When it began waiting, as an ISO time, where the node says. */
	readonly since?: string;
	readonly machine?: string;
	readonly quest?: string;
}

/**
 * The needs a listing's lines hold, the longest waiting first; a line
 * that is no cell, or names no cell, is skipped. Each text is held to one
 * line, since another session wrote it.
 */
export function needsFrom(listing: string): Need[] {
	return listing
		.split("\n")
		.flatMap((line) => {
			const need = needOf(line);
			return need ? [need] : [];
		})
		.sort((one, other) => {
			const [first, second] = [sinceOf(one), sinceOf(other)];
			if (first === second) return 0;
			return first < second ? -1 : 1;
		});
}

/** The need one line of the listing holds, or none. */
function needOf(line: string): Need | undefined {
	if (line.trim() === "") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		// A line torn or not JSON is no cell: the rest still read.
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const cell = value as Record<string, unknown>;
	if (typeof cell.name !== "string" || cell.name === "") return undefined;
	const said = (field: unknown) =>
		typeof field === "string" && field.trim() !== ""
			? oneLine(field)
			: undefined;
	const since = said(cell.since);
	const machine = said(cell.machine);
	const quest = said(cell.quest);
	return {
		name: oneLine(cell.name),
		title: said(cell.title) ?? "",
		asks: said(cell.asks) ?? said(cell.doing) ?? "",
		...(since !== undefined && Number.isFinite(Date.parse(since))
			? { since }
			: {}),
		...(machine !== undefined ? { machine } : {}),
		...(quest !== undefined ? { quest } : {}),
	};
}

/** When a need began, for ordering; one that doesn't say goes last. */
function sinceOf(need: Need): number {
	return need.since === undefined
		? Number.POSITIVE_INFINITY
		: Date.parse(need.since);
}
