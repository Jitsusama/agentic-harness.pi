/**
 * Fan-out spend, read from the run store rather than the session logs.
 *
 * Subagents and review rounds run as their own pi processes and write no
 * session log the ledger indexes, so the ledger's total is the main loop
 * alone. Last month that left about $13,000 out of a total that did not
 * say so. This totals the run store so the report can put the two side
 * by side, and says how much of the fan-out can be traced to the session
 * that launched it, which is what splitting it by quest would need.
 */
import type { RunRecord } from "@jitsusama/agentic-harness.core/observability";

/** One group of fan-out runs and what they cost. */
export interface FanOutSlice {
	readonly key: string;
	readonly cost: number;
	readonly runs: number;
}

/** What the run store says fan-out cost, and how much of it is traceable. */
export interface FanOutSummary {
	readonly cost: number;
	/** Every run, metered or not, so the count says what the price covers. */
	readonly runs: number;
	/** Runs that reported no usage: counted, never priced as free. */
	readonly unmetered: number;
	readonly byKind: readonly FanOutSlice[];
	/** Runs stamped with the session that launched them. */
	readonly traced: { readonly runs: number; readonly cost: number };
	/**
	 * When the earliest run started, epoch milliseconds. The run store
	 * begins months after the ledger does, so the two totals cover
	 * different windows and must not be added.
	 */
	readonly since?: number;
}

/** Dimensions the run store itself carries on every row. */
export type FanOutDimension = "model" | "day";

/** How fan-out is shown beside a grouped report. */
export interface FanOutView {
	readonly dimension: string;
	/** Present when the run store carries the dimension itself. */
	readonly slices?: readonly FanOutSlice[];
}

/**
 * Choose how fan-out is shown for a grouping. Kind, model and day come
 * from the run store's own columns. Repo, quest and session need the
 * launching session, which the store has stamped only since
 * 2026-09-23, so those get no slices rather than a guessed split.
 */
export function fanOutView(
	records: readonly RunRecord[],
	dimension: string | undefined,
	limit: number,
): FanOutView | undefined {
	if (dimension === undefined) return undefined;
	if (dimension === "kind") {
		return {
			dimension,
			slices: summarizeFanOut(records).byKind.slice(0, limit),
		};
	}
	if (dimension === "model" || dimension === "day") {
		return { dimension, slices: fanOutBy(records, dimension).slice(0, limit) };
	}
	return { dimension };
}

/** What a run with no model named was run on. */
const SETTINGS_DEFAULT = "settings default";

/** Total the run store by kind, heaviest first. */
export function summarizeFanOut(records: readonly RunRecord[]): FanOutSummary {
	let cost = 0;
	let unmetered = 0;
	let since: number | undefined;
	const traced = { runs: 0, cost: 0 };
	for (const record of records) {
		const spent = record.cost?.total ?? 0;
		if (since === undefined || record.startedAt < since) {
			since = record.startedAt;
		}
		if (record.cost === null) unmetered++;
		cost += spent;
		if (record.sessionId) {
			traced.runs++;
			traced.cost += spent;
		}
	}
	return {
		cost,
		runs: records.length,
		unmetered,
		byKind: heaviestFirst(group(records, (r) => r.kind)),
		traced,
		...(since === undefined ? {} : { since }),
	};
}

/**
 * Split the run store by one of its own dimensions: model heaviest
 * first, day in calendar order.
 */
export function fanOutBy(
	records: readonly RunRecord[],
	dimension: FanOutDimension,
): FanOutSlice[] {
	if (dimension === "model") {
		return heaviestFirst(group(records, (r) => r.model || SETTINGS_DEFAULT));
	}
	return group(records, (r) =>
		new Date(r.startedAt).toISOString().slice(0, 10),
	).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function group(
	records: readonly RunRecord[],
	keyOf: (record: RunRecord) => string,
): FanOutSlice[] {
	const slices = new Map<string, { cost: number; runs: number }>();
	for (const record of records) {
		const key = keyOf(record);
		const slice = slices.get(key) ?? { cost: 0, runs: 0 };
		slice.cost += record.cost?.total ?? 0;
		slice.runs++;
		slices.set(key, slice);
	}
	return [...slices].map(([key, s]) => ({ key, cost: s.cost, runs: s.runs }));
}

function heaviestFirst(slices: FanOutSlice[]): FanOutSlice[] {
	return slices.sort((a, b) => b.cost - a.cost || (a.key < b.key ? -1 : 1));
}
