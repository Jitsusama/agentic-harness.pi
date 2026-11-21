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
 *
 * An entry is the claim of whoever started the cell, as its seed's words
 * and tie are: the node passes a sprout's need on as it was given, and
 * the cell that sprouts one is most often a hub that took another's
 * need, so nothing here can check the asker. It grants nothing; it says
 * only why the cell was started.
 */

import { isRecord } from "../../record.ts";

/** The most characters a cell's address holds, as the node reads one. */
const ADDRESS_MOST = 32;

/** The longest need kept, in characters, as the node cuts one. */
const LONGEST_NEED = 280;

/** The most needs a forage lists, as the node keeps at most. */
export const MOST_SERVED = 64;

/**
 * A need's id as the mesh mints one (need-route.ts `needId`): the
 * asker's address, then its stamp in base 36 and six random bytes.
 */
const NEED_ID = /^([A-Za-z0-9]{1,32})\/[0-9a-z]{1,16}\.[0-9a-f]{12}$/u;

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
 * need but blanks, or dates it at no ISO time, keeping the last
 * `MOST_SERVED`, which are the newest, since each is added at the end,
 * and a forage says first what it serves now. Each need is on one line
 * and cut at the node's length, and an id that isn't a need's id of the
 * same cell is left off its entry.
 */
export function servedFrom(said: unknown): Served[] {
	if (!Array.isArray(said)) return [];
	return said
		.flatMap((one): Served[] => {
			const read = isRecord(one) ? servedOf(one) : undefined;
			return read ? [read] : [];
		})
		.slice(-MOST_SERVED);
}

/**
 * `listed` with `taken` added at its end, or nothing when `taken` reads
 * as no need or `listed` already holds it: the same need's id, or, where
 * either has none, the same cell and words. The entries already there
 * are kept as written, a hand's included, past the oldest beyond
 * `MOST_SERVED`, so adding one never rewrites the rest.
 */
export function withServed(
	listed: unknown,
	taken: Served,
): unknown[] | undefined {
	const read = servedOf({ ...taken });
	if (!read) return undefined;
	const held = servedFrom(listed).some((one) => sameNeed(one, read));
	if (held) return undefined;
	const kept = Array.isArray(listed) ? listed : [];
	return [...kept, read].slice(-MOST_SERVED);
}

/**
 * The asker a need's id names, or nothing when `id` isn't one as the
 * mesh mints it.
 */
export function needAsker(id: string): string | undefined {
	return NEED_ID.exec(id)?.[1];
}

/** Whether two entries are one need: by id where both have one. */
function sameNeed(one: Served, other: Served): boolean {
	if (one.id !== undefined && other.id !== undefined)
		return one.id === other.id;
	return (
		one.cell.toUpperCase() === other.cell.toUpperCase() &&
		one.need === other.need
	);
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
		...(typeof id === "string" &&
		needAsker(id)?.toUpperCase() === cell.toUpperCase()
			? { id }
			: {}),
	};
}
