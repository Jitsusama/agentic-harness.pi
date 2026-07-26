/**
 * The envelope every list-shaped answer arrives in.
 *
 * The context window is the screen these answers render to, so
 * the shape is summary first: what the whole list looks like,
 * then as much of it as the window and the byte budget allow,
 * then how to get the rest. Limits here are presentation
 * defaults, never ceilings: every one can be raised per call,
 * and anything cut says so and says how to retrieve it.
 */

/** What a caller may ask of any list. */
export interface ListArgs {
	readonly limit?: number;
	readonly cursor?: string;
	readonly ids?: readonly number[];
	readonly toDisk?: boolean;
	readonly budget?: number;
}

/** A window onto a list, with the whole list's shape around it. */
export interface Paged<T> {
	readonly total: number;
	readonly groups?: Record<string, number>;
	readonly items: readonly T[];
	readonly nextCursor?: string;
	readonly dropped?: number;
	readonly elided?: string;
	readonly artifactPath?: string;
}

/** What paging needs to know about the items it is windowing. */
export interface PageShape<T> {
	readonly idOf: (item: T) => number;
	readonly groupOf?: (item: T) => string;
	readonly sizeOf?: (item: T) => number;
	readonly more?: string;
	readonly dropped?: number;
}

/** How many items a window holds when the caller says nothing. */
export const DEFAULT_LIMIT = 20;

/** How many bytes a response spends on items when nothing says otherwise. */
export const DEFAULT_BUDGET_BYTES = 8192;

/** Window a list into the shared envelope. */
export function paginate<T>(
	all: readonly T[],
	args: ListArgs,
	shape: PageShape<T>,
): Paged<T> {
	const summary = {
		total: all.length,
		...(shape.groupOf ? { groups: countByGroup(all, shape.groupOf) } : {}),
		...(shape.dropped ? { dropped: shape.dropped } : {}),
	};

	// Naming ids is a detail fetch, not a walk: the window and
	// the cursor have nothing to say about it.
	if (args.ids) {
		const wanted = new Set(args.ids);
		return {
			...summary,
			items: all.filter((one) => wanted.has(shape.idOf(one))),
		};
	}

	const start = resumePoint(all, args.cursor, shape.idOf);
	const limit = args.limit ?? DEFAULT_LIMIT;
	const budget = args.budget ?? DEFAULT_BUDGET_BYTES;
	const candidates = all.slice(start, start + limit);
	const items = withinBudget(candidates, budget, shape.sizeOf ?? measure);

	const consumed = start + items.length;
	const remaining = all.length - consumed;
	const cut = candidates.length - items.length;

	return {
		...summary,
		items,
		// A cursor needs something to point at. With a limit of zero
		// there are no items and this read index -1, so asking for an
		// empty window of a non-empty list threw a TypeError instead
		// of answering with nothing.
		...(remaining > 0 && items.length > 0
			? { nextCursor: String(shape.idOf(items[items.length - 1])) }
			: {}),
		...(cut > 0 ? { elided: elision(cut, budget, shape.more) } : {}),
	};
}

/** Where a cursor says to carry on from. */
function resumePoint<T>(
	all: readonly T[],
	cursor: string | undefined,
	idOf: (item: T) => number,
): number {
	if (cursor === undefined) return 0;
	const last = Number(cursor);
	const at = all.findIndex((one) => idOf(one) === last);
	// A cursor whose item is gone (evicted, re-run) starts over
	// rather than silently skipping into the middle of the list.
	return at === -1 ? 0 : at + 1;
}

/** As many items as the byte budget affords, and never none. */
function withinBudget<T>(
	candidates: readonly T[],
	budget: number,
	sizeOf: (item: T) => number,
): T[] {
	const kept: T[] = [];
	let spent = 0;
	for (const one of candidates) {
		const cost = sizeOf(one);
		// One item always goes through: a record too big for the
		// budget must still be reachable, not invisible.
		if (kept.length > 0 && spent + cost > budget) break;
		kept.push(one);
		spent += cost;
	}
	return kept;
}

/** Say what the budget cut, and how the caller gets it anyway. */
function elision(cut: number, budget: number, more?: string): string {
	const ways = [
		"raise budget",
		...(more ? [more] : []),
		"or pass toDisk for the whole set",
	];
	return (
		`${cut} more ${cut === 1 ? "item" : "items"} in this window did not ` +
		`fit the ${budget} byte budget: ${ways.join(", ")}.`
	);
}

/** How many bytes an item costs when the caller has no opinion. */
function measure(item: unknown): number {
	return JSON.stringify(item)?.length ?? 0;
}

/** How many items fall in each group across the whole list. */
function countByGroup<T>(
	all: readonly T[],
	groupOf: (item: T) => string,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const one of all) {
		const group = groupOf(one);
		counts[group] = (counts[group] ?? 0) + 1;
	}
	return counts;
}
