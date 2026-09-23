/**
 * Fan-out spend, read from the run store rather than the session logs.
 *
 * Subagents and review rounds run as their own pi processes and write no
 * session log the ledger indexes, so the ledger's total is the main loop
 * alone. Last month that left about $13,000 out of a total that did not
 * say so. This totals the run store so the report can put the two side
 * by side, and splits it by the same dimensions the ledger answers,
 * joining each run to the ledger's record of the session that launched
 * it where the dimension lives on the session rather than the run.
 */
import type {
	RunRecord,
	SessionRecord,
} from "@jitsusama/agentic-harness.core/observability";

/** One group of fan-out runs and what they cost. */
export interface FanOutSlice {
	readonly key: string;
	readonly cost: number;
	readonly runs: number;
}

/** What the run store says fan-out cost. */
export interface FanOutSummary {
	readonly cost: number;
	/** Every run, metered or not, so the count says what the price covers. */
	readonly runs: number;
	/** Runs that reported no usage: counted, never priced as free. */
	readonly unmetered: number;
	readonly byKind: readonly FanOutSlice[];
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
	/**
	 * Heaviest first within the limit, with the unattributed slice (key
	 * "") kept whatever the limit, so a share is never of a total that
	 * quietly lost it.
	 */
	readonly slices?: readonly FanOutSlice[];
	/** Named slices before the limit, so a header counts all of them. */
	readonly named?: number;
	/** Set when the run store does not record this dimension at all. */
	readonly unrecorded?: true;
}

/** What a run with no model named was run on. */
const SETTINGS_DEFAULT = "settings default";

/** Total the run store by kind, heaviest first. */
export function summarizeFanOut(records: readonly RunRecord[]): FanOutSummary {
	let cost = 0;
	let unmetered = 0;
	let since: number | undefined;
	for (const record of records) {
		if (since === undefined || record.startedAt < since) {
			since = record.startedAt;
		}
		if (record.cost === null) unmetered++;
		cost += record.cost?.total ?? 0;
	}
	return {
		cost,
		runs: records.length,
		unmetered,
		byKind: heaviestFirst(group(records, (r) => r.kind)),
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

/**
 * Choose how fan-out is shown for a grouping. Kind, model, day and repo
 * come from the run's own columns. Quest and session live on the
 * session that launched the run, so they come from the ledger's record
 * of it. The run store does not record a thinking level, so that
 * grouping is named as unrecorded rather than split.
 */
export function fanOutView(
	records: readonly RunRecord[],
	dimension: string | undefined,
	limit: number,
	sessions: readonly SessionRecord[] = [],
): FanOutView | undefined {
	if (dimension === undefined) return undefined;
	if (dimension === "kind") {
		return { dimension, ...limited(summarizeFanOut(records).byKind, limit) };
	}
	if (dimension === "model" || dimension === "day") {
		// Heaviest first, as the ledger's own slices are, so a limit keeps
		// the costliest days rather than the oldest.
		return {
			dimension,
			...limited(heaviestFirst(fanOutBy(records, dimension)), limit),
		};
	}
	if (dimension === "repo") {
		return {
			dimension,
			...limited(heaviestFirst(group(records, (r) => r.repo ?? "")), limit),
		};
	}
	if (dimension === "quest" || dimension === "session") {
		const launched = byPiSessionId(sessions);
		const keyOf = (r: RunRecord): string => {
			const session = r.sessionId ? launched.get(r.sessionId) : undefined;
			return dimension === "session"
				? (session?.sessionId ?? r.sessionId ?? "")
				: (session?.quest ?? "");
		};
		return {
			dimension,
			...limited(heaviestFirst(group(records, keyOf)), limit),
		};
	}
	return { dimension, unrecorded: true };
}

/**
 * Index the ledger's sessions by pi's own session id. The ledger keys a
 * session by its log's file name, which ends in `_<session id>.jsonl`;
 * the run store stamps the bare id pi reports.
 */
function byPiSessionId(
	sessions: readonly SessionRecord[],
): Map<string, SessionRecord> {
	const index = new Map<string, SessionRecord>();
	for (const session of sessions) {
		const match = /_([^_]+)\.jsonl$/.exec(session.sessionId);
		if (match) index.set(match[1], session);
	}
	return index;
}

/**
 * The first named slices within the limit, in the order given, then the
 * unattributed one, with how many named slices there were in all.
 */
function limited(
	slices: readonly FanOutSlice[],
	limit: number,
): { slices: FanOutSlice[]; named: number } {
	const named = slices.filter((s) => s.key !== "");
	const blank = slices.find((s) => s.key === "");
	const shown = named.slice(0, limit);
	return { slices: blank ? [...shown, blank] : shown, named: named.length };
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
