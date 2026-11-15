/**
 * What the ledger reports: totals, spend by dimension, repeated and
 * regretted calls, verifier outcomes and the payback replay.
 *
 * Apart from the store because a report changes when the question it
 * answers does, while the store changes when how records are written
 * does. Each reads through a connection the store holds.
 */

import type { Db } from "../../internal/sqlite/db.ts";
import { sqlFile } from "../../internal/sqlite/sql-file.ts";
import { questOf } from "./shape.ts";
import type {
	CallScope,
	PaybackReplay,
	RegretReport,
	RepeatedCall,
	VerifierOutcome,
} from "./types.ts";

/** What a dimension's slice of spend came to. */
export interface CostSlice {
	readonly key: string;
	readonly cost: number;
	readonly turns: number;
}

/** Everything the ledger holds, with its own blind spots stated. */
export interface LedgerTotal {
	readonly cost: number;
	readonly turns: number;
	/** Turns held with no cost, so a total can say what it is missing. */
	readonly unmetered: number;
	readonly cacheWriteTokens: number;
	/** Of those, the ones billed at the one-hour rate. */
	readonly cacheWrite1hTokens: number;
}

/** What a total or a slice may be narrowed to. */
export type CostDimension =
	| "model"
	| "session"
	| "kind"
	| "day"
	| "repo"
	| "quest"
	| "document"
	| "thinking";

const TOTAL = sqlFile(new URL("./total.sql", import.meta.url));
const VERIFIER_OUTCOMES = sqlFile(
	new URL("./verifier-outcomes.sql", import.meta.url),
);
const PAYBACK = sqlFile(new URL("./payback.sql", import.meta.url));
const REPEATED_CALLS = sqlFile(
	new URL("./repeated-calls.sql", import.meta.url),
);
const DROPPED_IN_SCOPE = sqlFile(
	new URL("./dropped-in-scope.sql", import.meta.url),
);
const REGRET = sqlFile(new URL("./regret.sql", import.meta.url));

const GROUP_BY: Record<CostDimension, string> = {
	model: "turns.model",
	session: "turns.session_id",
	kind: "turns.kind",
	// The machine's own day, as the person lives it: a UTC day ends in
	// the evening west of Greenwich, splitting one evening's work in two.
	day: "date(turns.timestamp, 'localtime')",
	// A left join, and coalesced to the empty string, so spend whose
	// session named no repo or quest stays a visible slice. An inner join
	// would drop it, and every share would then be a fraction of a total
	// that quietly excluded most of the money.
	repo: "COALESCE(sessions.repo, '')",
	quest: `COALESCE(${questOf("turns", "sessions")}, '')`,
	document: "COALESCE(NULLIF(turns.document, ''), '')",
	thinking: "COALESCE(turns.thinking_level, '')",
};

/** Everything the ledger holds, with what it holds no cost for. */
export async function total(db: Db): Promise<LedgerTotal> {
	const rows = await db.all<{
		cost: number | null;
		turns: number;
		unmetered: number;
		cache_write: number | null;
		cache_write_1h: number | null;
	}>(TOTAL);
	const row = rows[0];
	return {
		cost: row?.cost ?? 0,
		turns: row?.turns ?? 0,
		unmetered: row?.unmetered ?? 0,
		cacheWriteTokens: row?.cache_write ?? 0,
		cacheWrite1hTokens: row?.cache_write_1h ?? 0,
	};
}

/**
 * Pass, fail and unknown counts per verifier kind that ran at all. A
 * kind nothing ever ran is left out rather than reported as zero,
 * since zero-and-never-ran read the same on a dashboard but mean
 * opposite things.
 */
export async function verifierOutcomes(db: Db): Promise<VerifierOutcome[]> {
	const rows = await db.all<{
		verifier_kind: string;
		passed: number;
		failed: number;
		unknown: number;
	}>(VERIFIER_OUTCOMES);
	return rows.map((row) => ({
		kind: row.verifier_kind as VerifierOutcome["kind"],
		passed: row.passed,
		failed: row.failed,
		unknown: row.unknown,
	}));
}

/**
 * Arguments asked more than once inside one session.
 *
 * Grouped by session as well as by arguments, because a second
 * session has none of the first one's context: asking again is the
 * only way it could know. Only repetition within a session is a
 * question whose answer was already there.
 *
 * Each call is compared with the previous asking of the same
 * arguments, and counts as a repeat only when no writer touched its
 * file in between: re-reading unchanged bytes is waste, re-reading a
 * file that was just edited is how the edit gets checked. `asked` is
 * therefore the repeats plus the asking they repeated, not every call
 * ever made with these arguments.
 */
export async function repeatedCalls(
	db: Db,
	scope: CallScope,
): Promise<RepeatedCall[]> {
	const rows = await db.all<{
		args_digest: string;
		name: string;
		repeated: number;
		repeated_chars: number | null;
		appraisal: number;
		appraisal_chars: number | null;
	}>(REPEATED_CALLS, scopeParams(scope));
	return rows.map((row) => ({
		argsDigest: row.args_digest,
		name: row.name,
		asked: row.repeated + 1,
		repeated: row.repeated,
		repeatedChars: row.repeated_chars ?? 0,
		rework: row.repeated - row.appraisal,
		reworkChars: (row.repeated_chars ?? 0) - (row.appraisal_chars ?? 0),
		appraisal: row.appraisal,
		appraisalChars: row.appraisal_chars ?? 0,
	}));
}

/**
 * Dropped calls asked again after the drop.
 *
 * Joined on the dropped call's own arguments and session, restricted
 * to a later call that came after the drop rather than before it: a
 * repeat that predates the drop is an ordinary repeat, not a case of
 * the context having to re-fetch what it lost.
 *
 * One row per dropped call, at its first re-ask. Joining every later
 * asking as its own row once turned a single call re-issued 79,600
 * times into 79,600 regrets. A re-ask after a writer touched the
 * dropped call's file fetched something new and does not count, and
 * neither does any re-ask after that, since each of them reads the
 * changed file rather than the one the drop discarded.
 */
export async function regret(db: Db, scope: CallScope): Promise<RegretReport> {
	const [retrieval, writers] = scopeParams(scope);
	const [counted] = await db.all<{ in_scope: number }>(DROPPED_IN_SCOPE, [
		retrieval,
	]);

	const rows = await db.all<{
		name: string;
		args_digest: string;
		session_id: string;
		dropped_at_timestamp: string;
		re_asked_at_timestamp: string;
		result_chars: number | null;
	}>(REGRET, [retrieval, writers]);
	return {
		inScope: counted?.in_scope ?? 0,
		reAsked: rows.map((row) => ({
			name: row.name,
			argsDigest: row.args_digest,
			sessionId: row.session_id,
			droppedAtTimestamp: row.dropped_at_timestamp,
			reAskedAtTimestamp: row.re_asked_at_timestamp,
			resultChars: row.result_chars,
		})),
	};
}

/**
 * Replay the payback test over compactions already in the ledger.
 *
 * Retained tokens come from the first turn after each compaction
 * (its resident input, cache read and cache write together), and
 * remaining turns from how many turns actually followed. A model's
 * rate is derived from its own billed dollars per token elsewhere in
 * the ledger, never a hardcoded price table, since a price table
 * goes stale the moment a provider changes its prices and this does
 * not.
 */
export async function paybackReplay(db: Db): Promise<PaybackReplay> {
	const rows = await db.all<{
		dropped_before: number;
		remaining: number | null;
		retained: number | null;
		read_rate: number | null;
		write_rate: number | null;
	}>(PAYBACK);

	let evaluable = 0;
	let agreed = 0;
	let disagreed = 0;
	for (const row of rows) {
		if (
			row.remaining === null ||
			row.retained === null ||
			row.read_rate === null ||
			row.write_rate === null ||
			row.read_rate <= 0
		) {
			continue;
		}
		evaluable += 1;
		const dropped = Math.max(0, row.dropped_before - row.retained);
		const saved = dropped * row.remaining;
		const ratio = row.write_rate / row.read_rate;
		const cost = ratio * row.retained;
		if (saved > cost) agreed += 1;
		else disagreed += 1;
	}
	return { compactions: rows.length, evaluable, agreed, disagreed };
}

/** Spend sliced by one dimension, the costliest slice first. */
export async function costBy(
	db: Db,
	dimension: CostDimension,
): Promise<CostSlice[]> {
	const column = GROUP_BY[dimension];
	const rows = await db.all<{
		key: string;
		cost: number | null;
		turns: number;
	}>(
		`SELECT ${column} AS key, SUM(cost_total) AS cost, COUNT(*) AS turns
			FROM turns
			LEFT JOIN sessions ON sessions.session_id = turns.session_id
			GROUP BY ${column} ORDER BY cost DESC`,
	);
	return rows.map((r) => ({
		key: r.key,
		cost: r.cost ?? 0,
		turns: r.turns,
	}));
}

/**
 * A call scope as the values its queries bind: the retrieval tools as a
 * JSON array, or null for every tool, then the writer tools as one,
 * empty when none are named. An empty retrieval list means the caller
 * named nothing in scope, which is answered with nothing rather than
 * silently widened to everything.
 */
function scopeParams(scope: CallScope): [string | null, string] {
	return [
		scope.retrieval === undefined ? null : JSON.stringify(scope.retrieval),
		JSON.stringify(scope.writers ?? []),
	];
}
