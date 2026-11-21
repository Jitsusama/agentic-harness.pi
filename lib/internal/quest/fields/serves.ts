/**
 * The needs a quest's cell took from other cells, kept in its README's
 * `serves` front matter, so a forage says why it exists: whose need it
 * took, what that need was about and since when.
 *
 * Presence says them as mycelium's node reads a cell's `serves` (its
 * forage.rs `joins`): each entry names the cell at the other end by
 * address, the need on one line, and an ISO time. An entry the node
 * would pass over is passed over here too, so what a presence says is
 * what the forage shows; the need's id, when known, rides beside it for
 * readers here, and the node ignores it.
 */

import { isRecord } from "../../record.ts";

/** The most characters a cell's address holds, as the node reads one. */
const ADDRESS_MOST = 32;

/** The longest need kept, in characters, as the node cuts one. */
const LONGEST_NEED = 280;

/** The most needs a forage lists, as the node keeps at most. */
export const MOST_SERVED = 64;

/** An ISO time with its offset, which the node's reader requires. */
const ISO_TIME =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** One need a cell took: whose it was, what it was about, and since when. */
export interface Served {
	/** The cell that put the need, by address. */
	readonly cell: string;
	/** What the need was about, on one line. */
	readonly need: string;
	/** When it was taken, as an ISO time. */
	readonly since: string;
	/** The need's id, as the mesh names it, when known. */
	readonly id?: string;
}

/**
 * The needs `said` lists, as a README's `serves` or a presence's holds
 * them, passing over each entry that names no cell by address, says no
 * need but blanks, or dates it at no ISO time, keeping at most
 * `MOST_SERVED`, each need on one line and cut at the node's length.
 */
export function servedFrom(said: unknown): Served[] {
	if (!Array.isArray(said)) return [];
	return said
		.flatMap((one): Served[] => {
			const read = isRecord(one) ? servedOf(one) : undefined;
			return read ? [read] : [];
		})
		.slice(0, MOST_SERVED);
}

/**
 * `listed` with `taken` added, or as it was when it already holds a need
 * from the same cell about the same thing, at most `MOST_SERVED`: past
 * that the newest are kept, since a forage says first what it serves now.
 */
export function withServed(listed: unknown, taken: Served): Served[] {
	const served = servedFrom(listed);
	const read = servedOf({ ...taken });
	if (!read) return served;
	const same = served.some(
		(one) => one.cell === read.cell && one.need === read.need,
	);
	return same ? served : [...served, read].slice(-MOST_SERVED);
}

/** Whether `said` could be a cell's address, as the node reads one. */
export function isCellAddress(said: string): boolean {
	return (
		said.length >= 1 &&
		said.length <= ADDRESS_MOST &&
		/^[A-Za-z0-9]+$/u.test(said)
	);
}

/** One entry read, or nothing where the node would pass it over. */
function servedOf(one: Record<string, unknown>): Served | undefined {
	const { cell, need, since, id } = one;
	if (typeof cell !== "string" || !isCellAddress(cell)) return undefined;
	if (typeof need !== "string" || typeof since !== "string") return undefined;
	const line = [...need.replace(/\s+/gu, " ").trim()]
		.slice(0, LONGEST_NEED)
		.join("")
		.trim();
	if (line === "") return undefined;
	const at = ISO_TIME.test(since) ? Date.parse(since) : Number.NaN;
	if (!Number.isFinite(at)) return undefined;
	return {
		cell,
		need: line,
		since: new Date(at).toISOString(),
		...(typeof id === "string" && id.trim() !== "" ? { id: id.trim() } : {}),
	};
}
