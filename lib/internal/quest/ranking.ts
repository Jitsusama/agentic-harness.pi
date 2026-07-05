/**
 * Pure rank-reordering math for sibling quests.
 *
 * A "sibling set" is the list of quests that share a
 * parent and a priority bucket. Each one carries a `rank`
 * integer; lower is more important. The functions here
 * take the current ordering and return the new ordering;
 * the extension does the disk writes.
 *
 * All functions produce a contiguous `1..N` numbering on
 * output, regardless of the input numbering. This means a
 * `bump` that succeeds shifts the rest of the bucket only
 * when ranks were already contiguous; otherwise it acts as
 * a renumber side-effect, which is what we want — the
 * bucket stays clean.
 */

export interface RankEntry {
	id: string;
	rank: number;
}

/**
 * The next free rank for a sibling set: one past the highest
 * existing rank, or 1 when the set is empty. Appends a new quest to
 * the end of its group so it never collides with an existing rank.
 */
export function nextRank(ranks: number[]): number {
	return ranks.length > 0 ? Math.max(...ranks) + 1 : 1;
}

/** Sort by rank ascending; stable on ties via the id. */
export function sortByRank<T extends RankEntry>(entries: T[]): T[] {
	return [...entries].sort((a, b) => {
		if (a.rank !== b.rank) return a.rank - b.rank;
		return a.id.localeCompare(b.id);
	});
}

/** Assign contiguous 1..N ranks in current order. */
export function renumber<T extends RankEntry>(entries: T[]): T[] {
	const sorted = sortByRank(entries);
	return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
}

function indexOf<T extends RankEntry>(entries: T[], id: string): number {
	return entries.findIndex((e) => e.id === id);
}

function move<T extends RankEntry>(
	entries: T[],
	from: number,
	to: number,
): T[] {
	const arr = [...entries];
	const [moved] = arr.splice(from, 1);
	arr.splice(to, 0, moved);
	return arr.map((e, i) => ({ ...e, rank: i + 1 }));
}

/** Move `id` to the top of the bucket. */
export function top<T extends RankEntry>(entries: T[], id: string): T[] {
	const sorted = sortByRank(entries);
	const i = indexOf(sorted, id);
	if (i < 0) return renumber(entries);
	return move(sorted, i, 0);
}

/** Move `id` to the bottom of the bucket. */
export function bottom<T extends RankEntry>(entries: T[], id: string): T[] {
	const sorted = sortByRank(entries);
	const i = indexOf(sorted, id);
	if (i < 0) return renumber(entries);
	return move(sorted, i, sorted.length - 1);
}

/** Swap `id` with the entry above it (move it up by one). */
export function bump<T extends RankEntry>(entries: T[], id: string): T[] {
	const sorted = sortByRank(entries);
	const i = indexOf(sorted, id);
	if (i <= 0) return renumber(entries);
	return move(sorted, i, i - 1);
}

/** Swap `id` with the entry below it (move it down by one). */
export function sink<T extends RankEntry>(entries: T[], id: string): T[] {
	const sorted = sortByRank(entries);
	const i = indexOf(sorted, id);
	if (i < 0 || i >= sorted.length - 1) return renumber(entries);
	return move(sorted, i, i + 1);
}

/** Place `id` immediately before `targetId`. */
export function before<T extends RankEntry>(
	entries: T[],
	id: string,
	targetId: string,
): T[] {
	if (id === targetId) return renumber(entries);
	const sorted = sortByRank(entries);
	const from = indexOf(sorted, id);
	const target = indexOf(sorted, targetId);
	if (from < 0 || target < 0) return renumber(entries);
	const adjustedTarget = from < target ? target - 1 : target;
	return move(sorted, from, adjustedTarget);
}

/** Place `id` immediately after `targetId`. */
export function after<T extends RankEntry>(
	entries: T[],
	id: string,
	targetId: string,
): T[] {
	if (id === targetId) return renumber(entries);
	const sorted = sortByRank(entries);
	const from = indexOf(sorted, id);
	const target = indexOf(sorted, targetId);
	if (from < 0 || target < 0) return renumber(entries);
	const adjustedTarget = from <= target ? target : target + 1;
	return move(sorted, from, adjustedTarget);
}

/** Diff two RankEntry lists: which entries changed rank? */
export function diffRanks<T extends RankEntry>(
	before: T[],
	after: T[],
): { id: string; from: number; to: number }[] {
	const beforeMap = new Map(before.map((e) => [e.id, e.rank]));
	const out: { id: string; from: number; to: number }[] = [];
	for (const entry of after) {
		const prior = beforeMap.get(entry.id);
		if (prior === undefined || prior !== entry.rank) {
			out.push({ id: entry.id, from: prior ?? Number.NaN, to: entry.rank });
		}
	}
	return out;
}
