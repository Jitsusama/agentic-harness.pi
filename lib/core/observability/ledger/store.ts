import { type Db, openDb } from "../../internal/sqlite/db.ts";
import type {
	CallScope,
	DroppedCallRecord,
	PaybackReplay,
	QueryAnswer,
	RegretReport,
	RepeatedCall,
	SessionRecord,
	ToolCallRecord,
	TurnRecord,
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

/** How many turns a write added, and how many it had already seen. */
export interface RecordOutcome {
	readonly inserted: number;
	readonly duplicates: number;
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

/** A content-addressed store of billable turns. */
export interface TurnStore {
	recordTurns(turns: readonly TurnRecord[]): Promise<RecordOutcome>;
	recordSession(session: SessionRecord): Promise<void>;
	recordCalls(calls: readonly ToolCallRecord[]): Promise<RecordOutcome>;
	queryCalls(): Promise<ToolCallRecord[]>;
	/** Arguments asked more than once in one session, heaviest first. */
	repeatedCalls(scope?: CallScope): Promise<RepeatedCall[]>;
	recordDropped(dropped: readonly DroppedCallRecord[]): Promise<RecordOutcome>;
	queryDropped(): Promise<DroppedCallRecord[]>;
	/** Dropped calls asked again after the drop, with how many could have been. */
	regret(scope?: CallScope): Promise<RegretReport>;
	/** Pass, fail and unknown counts per verifier kind that ran at all. */
	verifierOutcomes(): Promise<VerifierOutcome[]>;
	/** How real compactions compare against the payback test. */
	paybackReplay(): Promise<PaybackReplay>;
	total(): Promise<LedgerTotal>;
	costBy(dimension: CostDimension): Promise<CostSlice[]>;
	/** Every session the ledger holds, for another store to join to. */
	sessions(): Promise<SessionRecord[]>;
	close(): Promise<void>;
}

/**
 * `digest` is the primary key rather than the session and entry pair,
 * which is what makes recording idempotent. `sightings` keeps the fact
 * that several logs held the same turn, so nothing is hidden by
 * deduplicating it: the turn is billed once and known to have been seen
 * more than once.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
	digest TEXT PRIMARY KEY,
	entry_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	kind TEXT NOT NULL,
	model TEXT NOT NULL,
	tokens_input INTEGER NOT NULL,
	tokens_output INTEGER NOT NULL,
	tokens_cache_read INTEGER NOT NULL,
	tokens_cache_write INTEGER NOT NULL,
	tokens_total INTEGER NOT NULL,
	cache_write_1h INTEGER NOT NULL,
	cost_input REAL,
	cost_output REAL,
	cost_cache_read REAL,
	cost_cache_write REAL,
	cost_total REAL,
	dropped_before INTEGER,
	first_kept_entry_id TEXT
);
CREATE INDEX IF NOT EXISTS turns_timestamp ON turns (timestamp);
CREATE INDEX IF NOT EXISTS turns_session ON turns (session_id);
CREATE INDEX IF NOT EXISTS turns_session_time ON turns (session_id, timestamp);
CREATE TABLE IF NOT EXISTS sightings (
	digest TEXT NOT NULL,
	session_id TEXT NOT NULL,
	PRIMARY KEY (digest, session_id)
);
CREATE TABLE IF NOT EXISTS tool_calls (
	digest TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	call_id TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	name TEXT NOT NULL,
	args_digest TEXT NOT NULL,
	path TEXT,
	result_chars INTEGER,
	result_digest TEXT,
	is_error INTEGER,
	verifier_kind TEXT
);
CREATE INDEX IF NOT EXISTS tool_calls_verifier ON tool_calls (verifier_kind);
CREATE INDEX IF NOT EXISTS tool_calls_args ON tool_calls (session_id, args_digest);
CREATE INDEX IF NOT EXISTS tool_calls_path ON tool_calls (path);
CREATE INDEX IF NOT EXISTS tool_calls_session_verifier
	ON tool_calls (session_id, timestamp) WHERE verifier_kind IS NOT NULL;
CREATE TABLE IF NOT EXISTS dropped_calls (
	digest TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	dropped_at_entry_id TEXT NOT NULL,
	dropped_at_timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	session_id TEXT PRIMARY KEY,
	cwd TEXT,
	repo TEXT,
	quest TEXT,
	first_seen TEXT,
	last_seen TEXT
);
`;

/**
 * Columns added to `turns` after its first shape, each with the record
 * field it holds. Declared once, because the migration that adds them,
 * the insert that writes them and the fill that back-dates them onto a
 * held turn must agree, and three lists drift.
 */
const FACT_COLUMNS: ReadonlyArray<{
	readonly column: string;
	readonly type: "TEXT" | "INTEGER";
	readonly value: (turn: TurnRecord) => unknown;
}> = [
	{ column: "thinking_level", type: "TEXT", value: (t) => t.thinkingLevel },
	{
		column: "preceded_by",
		type: "TEXT",
		value: (t) => t.facts?.precededBy ?? null,
	},
	{ column: "gap_ms", type: "INTEGER", value: (t) => t.facts?.gapMs ?? null },
	{
		column: "new_tokens",
		type: "INTEGER",
		value: (t) => t.facts?.newTokens ?? null,
	},
	{
		column: "stop_reason",
		type: "TEXT",
		value: (t) => t.facts?.stopReason ?? null,
	},
	{
		column: "thinking_chars",
		type: "INTEGER",
		value: (t) => t.facts?.thinkingChars ?? null,
	},
	{
		column: "text_chars",
		type: "INTEGER",
		value: (t) => t.facts?.textChars ?? null,
	},
	{ column: "run_id", type: "TEXT", value: (t) => t.facts?.runId ?? null },
	{
		column: "run_turn",
		type: "INTEGER",
		value: (t) => t.facts?.runTurn ?? null,
	},
	{
		column: "written",
		type: "TEXT",
		value: (t) => t.compaction?.written ?? null,
	},
	{
		column: "summariser",
		type: "TEXT",
		value: (t) => t.compaction?.summariser ?? null,
	},
	{
		column: "summary_ms",
		type: "INTEGER",
		value: (t) => t.compaction?.summaryMs ?? null,
	},
	{
		column: "waited_ms",
		type: "INTEGER",
		value: (t) => t.compaction?.waitedMs ?? null,
	},
	{
		column: "summary_chars",
		type: "INTEGER",
		value: (t) => t.compaction?.summaryChars ?? null,
	},
	{
		column: "aborted_request",
		type: "INTEGER",
		value: (t) => flag(t.compaction?.abortedRequest),
	},
	{
		column: "resumed",
		type: "INTEGER",
		value: (t) => flag(t.compaction?.resumed),
	},
	{
		column: "since_typed_ms",
		type: "INTEGER",
		value: (t) => t.compaction?.sinceTypedMs ?? null,
	},
	{ column: "quest", type: "TEXT", value: (t) => booked(t.quest) },
	{ column: "document", type: "TEXT", value: (t) => booked(t.document) },
];

/**
 * A booking as stored: null when the log was not read for it, and the
 * empty string when it was and named none. Null has to stay free for
 * unknown, since only an unknown booking falls back to the session's,
 * and a back-fill writes only over null.
 */
function booked(value: string | null | undefined): string | null {
	if (value === undefined) return null;
	return value ?? "";
}

/**
 * The quest a turn is booked to, in SQL over `turns` and `sessions`
 * under the names given: its own where the scan said, the session's
 * where it did not.
 */
function questOf(turns: string, sessions: string): string {
	return `CASE WHEN ${turns}.quest IS NULL THEN ${sessions}.quest ELSE NULLIF(${turns}.quest, '') END`;
}

/** SQLite has no boolean; unknown stays null rather than reading as false. */
function flag(value: boolean | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	return value ? 1 : 0;
}

/**
 * A cache write this many tokens past the estimate of what was new is
 * prompt framing and rounding, not a miss.
 */
const MISS_SLACK_TOKENS = 2000;

/** A write this far past the estimate, after the slack, is a miss. */
const MISS_THRESHOLD_TOKENS = 5000;

/** Idle past this and a one-hour cache has expired. */
const HOUR_MS = 3_600_000;

/** Idle past this and a five-minute cache has expired. */
const FIVE_MINUTES_MS = 300_000;

/** A turn that read less than this from the cache read nothing useful. */
const FULL_MISS_READ_TOKENS = 1000;

/**
 * The views a query is written against, dropped and made again on every
 * open, so a ledger always answers with this version's definitions
 * rather than whichever version first created it. Each is defined here
 * once, so a named report and an ad hoc query cannot disagree.
 */
const VIEWS = `
DROP VIEW IF EXISTS compaction_moments;
DROP VIEW IF EXISTS runs;
DROP VIEW IF EXISTS cycles;
DROP VIEW IF EXISTS misses;
DROP VIEW IF EXISTS turn_facts;

CREATE VIEW turn_facts AS
SELECT t.digest, t.entry_id, t.session_id, t.timestamp,
	substr(t.timestamp, 1, 10) AS day,
	t.kind, t.model, t.thinking_level,
	t.tokens_input + t.tokens_cache_read + t.tokens_cache_write AS context,
	t.tokens_input, t.tokens_output, t.tokens_cache_read,
	t.tokens_cache_write, t.cache_write_1h,
	t.cost_total AS cost, t.cost_input, t.cost_output,
	t.cost_cache_read, t.cost_cache_write,
	t.preceded_by, t.gap_ms, t.new_tokens, t.stop_reason,
	t.thinking_chars, t.text_chars, t.run_id, t.run_turn,
	t.dropped_before, t.first_kept_entry_id,
	s.repo, ${questOf("t", "s")} AS quest, s.cwd,
	NULLIF(t.document, '') AS document
FROM turns AS t
LEFT JOIN sessions AS s ON s.session_id = t.session_id;

CREATE VIEW misses AS
SELECT f.*,
	f.tokens_cache_write - f.new_tokens - ${MISS_SLACK_TOKENS} AS excess_tokens,
	(f.tokens_cache_write - f.new_tokens - ${MISS_SLACK_TOKENS})
		* f.cost_cache_write / f.tokens_cache_write AS excess_cost,
	CASE
		WHEN f.preceded_by = 'compaction' THEN 'after compaction'
		WHEN f.preceded_by = 'model' THEN 'model change'
		WHEN f.gap_ms > ${HOUR_MS} THEN 'idle over an hour'
		WHEN f.gap_ms > ${FIVE_MINUTES_MS} AND f.cache_write_1h = 0
			THEN 'idle over five minutes'
		WHEN f.preceded_by IN ('tools', 'system') THEN 'prompt changed'
		WHEN f.preceded_by = 'typed' THEN 'after a typed message'
		WHEN f.tokens_cache_read < ${FULL_MISS_READ_TOKENS}
			THEN 'full miss, unexplained'
		ELSE 'partial miss, unexplained'
	END AS cause
FROM turn_facts AS f
WHERE f.kind = 'assistant'
	AND f.gap_ms IS NOT NULL
	AND f.new_tokens IS NOT NULL
	AND f.tokens_cache_write > 0
	AND f.tokens_cache_write - f.new_tokens - ${MISS_SLACK_TOKENS}
		> ${MISS_THRESHOLD_TOKENS};

CREATE VIEW cycles AS
WITH numbered AS (
	SELECT f.*,
		SUM(CASE WHEN f.kind = 'compaction' THEN 1 ELSE 0 END) OVER (
			PARTITION BY f.session_id ORDER BY f.timestamp, f.digest
			ROWS UNBOUNDED PRECEDING
		) AS cycle
	FROM turn_facts AS f
),
worked AS (
	SELECT n.*,
		ROW_NUMBER() OVER (
			PARTITION BY n.session_id, n.cycle ORDER BY n.timestamp, n.digest
		) AS first_rank,
		ROW_NUMBER() OVER (
			PARTITION BY n.session_id, n.cycle
			ORDER BY n.timestamp DESC, n.digest DESC
		) AS last_rank
	FROM numbered AS n
	WHERE n.cycle > 0 AND n.kind = 'assistant' AND n.context > 0
),
opened AS (
	SELECT session_id, cycle, digest AS compaction_digest,
		timestamp AS compacted_at, repo, quest
	FROM numbered WHERE kind = 'compaction'
),
last_cycle AS (
	SELECT session_id, MAX(cycle) AS cycles FROM numbered GROUP BY session_id
),
sided AS (
	SELECT session_id, cycle, SUM(cost) AS side_cost
	FROM numbered WHERE cycle > 0 AND kind = 'side'
	GROUP BY session_id, cycle
)
SELECT o.session_id, o.cycle, o.compaction_digest, o.compacted_at,
	MAX(w.timestamp) AS ended_at,
	COUNT(w.digest) AS turns,
	COALESCE(SUM(w.cost), 0) AS cost,
	COALESCE(MAX(sd.side_cost), 0) AS side_cost,
	MAX(CASE WHEN w.first_rank = 1 THEN w.context END) AS context_start,
	MAX(CASE WHEN w.last_rank = 1 THEN w.context END) AS context_end,
	o.cycle < l.cycles AS closed,
	o.repo, o.quest
FROM opened AS o
JOIN last_cycle AS l ON l.session_id = o.session_id
LEFT JOIN worked AS w ON w.session_id = o.session_id AND w.cycle = o.cycle
LEFT JOIN sided AS sd ON sd.session_id = o.session_id AND sd.cycle = o.cycle
GROUP BY o.session_id, o.cycle;

CREATE VIEW runs AS
SELECT run_id, MIN(session_id) AS session_id,
	MIN(timestamp) AS started_at, MAX(timestamp) AS ended_at,
	SUM(CASE WHEN kind = 'assistant' THEN 1 ELSE 0 END) AS turns,
	SUM(CASE WHEN kind = 'compaction' THEN 1 ELSE 0 END) AS compactions,
	COALESCE(SUM(cost), 0) AS cost,
	MAX(repo) AS repo, MAX(quest) AS quest
FROM turn_facts
WHERE run_id IS NOT NULL
GROUP BY run_id;

CREATE VIEW compaction_moments AS
WITH next_turn AS (
	SELECT c.digest, MIN(n.timestamp) AS next_at
	FROM turns AS c
	JOIN turns AS n
		ON n.session_id = c.session_id
		AND n.kind = 'assistant'
		AND n.timestamp > c.timestamp
	WHERE c.kind = 'compaction'
	GROUP BY c.digest
)
SELECT f.digest, f.session_id, f.timestamp, f.day, f.model,
	f.cost, f.dropped_before, f.gap_ms, f.run_id,
	f.run_turn AS turns_into_run,
	t.written, t.summariser, t.summary_ms, t.waited_ms, t.summary_chars,
	t.aborted_request, t.resumed, t.since_typed_ms,
	nx.next_at,
	CAST(ROUND((julianday(nx.next_at) - julianday(f.timestamp)) * 86400000)
		AS INTEGER) AS resume_ms,
	f.repo, f.quest
FROM turn_facts AS f
JOIN turns AS t ON t.digest = f.digest
LEFT JOIN next_turn AS nx ON nx.digest = f.digest
WHERE f.kind = 'compaction';
`;

/**
 * The most rows one query may return. A query past it is refused rather
 * than cut, since a cut answer reads as the whole one; aggregating or a
 * LIMIT is how to ask for less.
 */
export const LEDGER_QUERY_ROW_CAP = 5000;

/** Bound variables per probe, well inside SQLite's default ceiling. */
const PROBE_CHUNK = 500;

const GROUP_BY: Record<CostDimension, string> = {
	model: "turns.model",
	session: "turns.session_id",
	kind: "turns.kind",
	day: "substr(turns.timestamp, 1, 10)",
	// A left join, and coalesced to the empty string, so spend whose
	// session named no repo or quest stays a visible slice. An inner join
	// would drop it, and every share would then be a fraction of a total
	// that quietly excluded most of the money.
	repo: "COALESCE(sessions.repo, '')",
	quest: `COALESCE(${questOf("turns", "sessions")}, '')`,
	document: "COALESCE(NULLIF(turns.document, ''), '')",
	thinking: "COALESCE(turns.thinking_level, '')",
};

/**
 * Open (creating if needed) a turn ledger at the given path. Safe to
 * point at the same file as the run store: the tables are disjoint and
 * WAL keeps readers clear of the single writer.
 */
export async function openTurnStore(dbPath: string): Promise<TurnStore> {
	const db = await openDb(dbPath);
	await db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
	await db.exec(SCHEMA);
	await migrate(db);
	await db.exec(VIEWS);
	return new SqliteTurnStore(db);
}

/** A read-only view of a ledger, for questions nobody wrote a report for. */
export interface LedgerReader {
	/**
	 * Run one `SELECT` (or `WITH ... SELECT`) against the ledger's tables
	 * and views. Anything else is refused before it reaches the database,
	 * and the connection is read-only besides, so no query can change what
	 * the ledger holds. A query returning more than
	 * {@link LEDGER_QUERY_ROW_CAP} rows is refused rather than cut.
	 */
	query(sql: string): Promise<QueryAnswer>;
	close(): Promise<void>;
}

/**
 * Open a ledger for reading only. The file must exist and have been
 * opened by {@link openTurnStore} at this version, which is what creates
 * the views a query is written against.
 */
export async function openLedgerReader(dbPath: string): Promise<LedgerReader> {
	const db = await openDb(dbPath, { readOnly: true });
	await db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
	return {
		query: async (sql) => {
			const statement = singleSelect(sql);
			// On lines of their own, so a trailing comment in the query cannot
			// swallow the bound.
			const rows = await db.all<Record<string, unknown>>(
				`SELECT * FROM (\n${statement}\n) LIMIT ${LEDGER_QUERY_ROW_CAP + 1}`,
			);
			if (rows.length > LEDGER_QUERY_ROW_CAP) {
				throw new Error(
					`The query returned more than ${LEDGER_QUERY_ROW_CAP} rows. ` +
						"Aggregate it, or add a LIMIT.",
				);
			}
			return { columns: Object.keys(rows[0] ?? {}), rows };
		},
		close: () => db.close(),
	};
}

/**
 * The statement, if it is one `SELECT` or `WITH`, with a trailing
 * semicolon taken off. A semicolon anywhere else outside a quoted string
 * means a second statement, which is refused rather than guessed about.
 */
function singleSelect(sql: string): string {
	const body = sql.trim().replace(/;\s*$/, "");
	if (!/^(select|with)\b/i.test(body)) {
		throw new Error(
			"A ledger query is one SELECT, or WITH ... SELECT. Nothing else runs.",
		);
	}
	let quote: string | null = null;
	for (const character of body) {
		if (quote) {
			if (character === quote) quote = null;
		} else if (character === "'" || character === '"') {
			quote = character;
		} else if (character === ";") {
			throw new Error("A ledger query is one statement.");
		}
	}
	return body;
}

/**
 * Bring a ledger written at an older shape up to this one. A new ledger
 * is created at the original shape and migrated like any other, so every
 * test that opens a fresh store also exercises the path an existing file
 * meets. Every step is additive, so nothing a ledger holds can be lost by
 * opening it.
 */
async function migrate(db: Db): Promise<void> {
	const columns = new Set(
		(await db.all<{ name: string }>("PRAGMA table_info(turns)")).map(
			(column) => column.name,
		),
	);
	for (const { column, type } of FACT_COLUMNS) {
		if (!columns.has(column)) {
			await db.exec(`ALTER TABLE turns ADD COLUMN ${column} ${type}`);
		}
	}
}

const INSERT_TURN = `INSERT OR IGNORE INTO turns (
	digest, entry_id, session_id, timestamp, kind, model,
	tokens_input, tokens_output, tokens_cache_read,
	tokens_cache_write, tokens_total, cache_write_1h,
	cost_input, cost_output, cost_cache_read, cost_cache_write,
	cost_total, dropped_before, first_kept_entry_id,
	${FACT_COLUMNS.map((f) => f.column).join(", ")}
) VALUES (${Array.from({ length: 19 + FACT_COLUMNS.length }, () => "?").join(", ")})`;

/**
 * Give a held turn every fact a later scan learned that it lacks. A fact
 * already known is left alone, since the same entry cannot have two.
 */
const FILL_FACTS = `UPDATE turns SET ${FACT_COLUMNS.map(
	(f) => `${f.column} = COALESCE(${f.column}, ?)`,
).join(", ")} WHERE digest = ?`;

class SqliteTurnStore implements TurnStore {
	private readonly db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	async recordTurns(turns: readonly TurnRecord[]): Promise<RecordOutcome> {
		// Collapse the batch against itself first, then ask the table once
		// which of the survivors it already holds. Counting rows per insert
		// instead would make a corpus pass quadratic: 40,000 turns is 1.6
		// billion scanned rows, which does not finish.
		const fresh = new Map<string, TurnRecord>();
		for (const t of turns) if (!fresh.has(t.digest)) fresh.set(t.digest, t);
		const known = await this.known([...fresh.keys()]);

		// One transaction per batch rather than one per row. Each row is
		// otherwise its own durable commit, which is disk-sync bound: a
		// first pass over the corpus took 13 minutes on that shape.
		await this.db.exec("BEGIN");
		try {
			const inserted = await this.writeAll(fresh, known);
			await this.db.exec("COMMIT");
			return { inserted, duplicates: turns.length - inserted };
		} catch (error) {
			await this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private async writeAll(
		fresh: ReadonlyMap<string, TurnRecord>,
		known: ReadonlySet<string>,
	): Promise<number> {
		let inserted = 0;
		for (const t of fresh.values()) {
			if (known.has(t.digest)) {
				// Seen before, so not billed again, but the sighting is still
				// recorded: deduplicating must not hide that it happened.
				await this.sight(t);
				await this.fillFacts(t);
				continue;
			}
			// Another session indexing the same logs may have landed this row
			// since the table was asked, so what counts is whether this
			// statement wrote it, not whether the probe had seen it.
			const { changes } = await this.db.run(INSERT_TURN, [
				t.digest,
				t.entryId,
				t.sessionId,
				t.timestamp,
				t.kind,
				t.model,
				t.tokens.input,
				t.tokens.output,
				t.tokens.cacheRead,
				t.tokens.cacheWrite,
				t.tokens.total,
				t.cacheWrite1h,
				t.cost?.input ?? null,
				t.cost?.output ?? null,
				t.cost?.cacheRead ?? null,
				t.cost?.cacheWrite ?? null,
				t.cost?.total ?? null,
				t.droppedBefore,
				t.firstKeptEntryId,
				...FACT_COLUMNS.map((f) => f.value(t)),
			]);
			inserted += changes;
			await this.sight(t);
			if (changes === 0) await this.fillFacts(t);
		}
		return inserted;
	}

	async total(): Promise<LedgerTotal> {
		const rows = await this.db.all<{
			cost: number | null;
			turns: number;
			unmetered: number;
			cache_write: number | null;
			cache_write_1h: number | null;
		}>(
			`SELECT
				SUM(cost_total) AS cost,
				COUNT(*) AS turns,
				SUM(CASE WHEN cost_total IS NULL THEN 1 ELSE 0 END) AS unmetered,
				SUM(tokens_cache_write) AS cache_write,
				SUM(cache_write_1h) AS cache_write_1h
			FROM turns`,
		);
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
	 * Record tool calls, each once however many logs or concurrent passes
	 * hold it.
	 */
	async recordCalls(calls: readonly ToolCallRecord[]): Promise<RecordOutcome> {
		const fresh = new Map<string, ToolCallRecord>();
		for (const c of calls) if (!fresh.has(c.digest)) fresh.set(c.digest, c);
		const known = await this.knownCalls([...fresh.keys()]);

		await this.db.exec("BEGIN");
		try {
			let inserted = 0;
			for (const c of fresh.values()) {
				if (known.has(c.digest)) continue;
				// Ignored rather than refused: a concurrent pass over the same
				// logs may have landed it since the probe, which is not an error.
				const { changes } = await this.db.run(
					`INSERT OR IGNORE INTO tool_calls (
						digest, session_id, entry_id, call_id, timestamp, name,
						args_digest, path, result_chars, result_digest, is_error,
						verifier_kind
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						c.digest,
						c.sessionId,
						c.entryId,
						c.callId,
						c.timestamp,
						c.name,
						c.argsDigest,
						c.path,
						c.resultChars,
						c.resultDigest,
						// Null is not false: a call whose result never arrived
						// did not come back succeeding.
						c.isError === null ? null : c.isError ? 1 : 0,
						c.verifierKind,
					],
				);
				inserted += changes;
			}
			await this.db.exec("COMMIT");
			return { inserted, duplicates: calls.length - inserted };
		} catch (error) {
			await this.db.exec("ROLLBACK");
			throw error;
		}
	}

	async queryCalls(): Promise<ToolCallRecord[]> {
		const rows = await this.db.all<CallRow>(
			"SELECT * FROM tool_calls ORDER BY timestamp ASC",
		);
		return rows.map((row) => ({
			digest: row.digest,
			sessionId: row.session_id,
			entryId: row.entry_id,
			callId: row.call_id,
			timestamp: row.timestamp,
			name: row.name,
			argsDigest: row.args_digest,
			path: row.path,
			resultChars: row.result_chars,
			resultDigest: row.result_digest,
			isError: row.is_error === null ? null : row.is_error === 1,
			verifierKind: row.verifier_kind as ToolCallRecord["verifierKind"],
		}));
	}

	/**
	 * Pass, fail and unknown counts per verifier kind that ran at all. A
	 * kind nothing ever ran is left out rather than reported as zero,
	 * since zero-and-never-ran read the same on a dashboard but mean
	 * opposite things.
	 */
	async verifierOutcomes(): Promise<VerifierOutcome[]> {
		const rows = await this.db.all<{
			verifier_kind: string;
			passed: number;
			failed: number;
			unknown: number;
		}>(
			`SELECT verifier_kind,
				SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) AS passed,
				SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS failed,
				SUM(CASE WHEN is_error IS NULL THEN 1 ELSE 0 END) AS unknown
			FROM tool_calls
			WHERE verifier_kind IS NOT NULL
			GROUP BY verifier_kind`,
		);
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
	async repeatedCalls(scope: CallScope = {}): Promise<RepeatedCall[]> {
		const retrieval = inList("c.name", scope.retrieval);
		const changed = writtenBetween(
			"o",
			"o.previous_at",
			"o.timestamp",
			scope.writers,
		);
		const rows = await this.db.all<{
			args_digest: string;
			name: string;
			repeated: number;
			repeated_chars: number | null;
			appraisal: number;
			appraisal_chars: number | null;
		}>(
			`WITH ordered AS (
				SELECT c.session_id, c.args_digest, c.name, c.path,
					c.timestamp, c.result_chars, c.verifier_kind,
					LAG(c.timestamp) OVER (
						PARTITION BY c.session_id, c.args_digest
						ORDER BY c.timestamp, c.digest
					) AS previous_at
				FROM tool_calls AS c
				WHERE ${retrieval.sql}
			),
			repeats AS (
				SELECT o.session_id, o.args_digest, o.name, o.result_chars,
					(o.verifier_kind IS NOT NULL OR EXISTS (
						SELECT 1 FROM tool_calls AS v
						WHERE v.session_id = o.session_id
							AND v.verifier_kind IS NOT NULL
							AND v.timestamp > o.previous_at
							AND v.timestamp < o.timestamp
					)) AS is_appraisal
				FROM ordered AS o
				WHERE o.previous_at IS NOT NULL AND NOT (${changed.sql})
			)
			SELECT args_digest, name, COUNT(*) AS repeated,
				SUM(COALESCE(result_chars, 0)) AS repeated_chars,
				SUM(is_appraisal) AS appraisal,
				SUM(CASE WHEN is_appraisal THEN COALESCE(result_chars, 0) ELSE 0 END)
					AS appraisal_chars
			FROM repeats
			GROUP BY session_id, args_digest
			ORDER BY repeated_chars DESC`,
			[...retrieval.params, ...changed.params],
		);
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

	async recordDropped(
		dropped: readonly DroppedCallRecord[],
	): Promise<RecordOutcome> {
		const fresh = new Map<string, DroppedCallRecord>();
		for (const d of dropped) {
			if (!fresh.has(d.callDigest)) fresh.set(d.callDigest, d);
		}
		const known = await this.alreadyHeld("dropped_calls", [...fresh.keys()]);

		await this.db.exec("BEGIN");
		try {
			let inserted = 0;
			for (const d of fresh.values()) {
				if (known.has(d.callDigest)) continue;
				const { changes } = await this.db.run(
					`INSERT OR IGNORE INTO dropped_calls (
						digest, session_id, dropped_at_entry_id, dropped_at_timestamp
					) VALUES (?, ?, ?, ?)`,
					[d.callDigest, d.sessionId, d.droppedAtEntryId, d.droppedAtTimestamp],
				);
				inserted += changes;
			}
			await this.db.exec("COMMIT");
			return { inserted, duplicates: dropped.length - inserted };
		} catch (error) {
			await this.db.exec("ROLLBACK");
			throw error;
		}
	}

	async queryDropped(): Promise<DroppedCallRecord[]> {
		const rows = await this.db.all<{
			digest: string;
			session_id: string;
			dropped_at_entry_id: string;
			dropped_at_timestamp: string;
		}>("SELECT * FROM dropped_calls ORDER BY dropped_at_timestamp ASC");
		return rows.map((row) => ({
			callDigest: row.digest,
			sessionId: row.session_id,
			droppedAtEntryId: row.dropped_at_entry_id,
			droppedAtTimestamp: row.dropped_at_timestamp,
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
	async regret(scope: CallScope = {}): Promise<RegretReport> {
		const retrieval = inList("dropped.name", scope.retrieval);
		const [counted] = await this.db.all<{ in_scope: number }>(
			`SELECT COUNT(*) AS in_scope
			FROM dropped_calls
			JOIN tool_calls AS dropped ON dropped.digest = dropped_calls.digest
			WHERE ${retrieval.sql}`,
			retrieval.params,
		);

		const changed = writtenBetween(
			"dropped",
			"dropped.timestamp",
			"re_ask.timestamp",
			scope.writers,
		);
		// SQLite takes a bare column alongside MIN from the row MIN chose,
		// which is what makes result_chars the first re-ask's own size.
		const rows = await this.db.all<{
			name: string;
			args_digest: string;
			session_id: string;
			dropped_at_timestamp: string;
			re_asked_at_timestamp: string;
			result_chars: number | null;
		}>(
			`SELECT dropped_calls.session_id AS session_id,
				dropped.name AS name,
				dropped.args_digest AS args_digest,
				dropped_calls.dropped_at_timestamp AS dropped_at_timestamp,
				MIN(re_ask.timestamp) AS re_asked_at_timestamp,
				re_ask.result_chars AS result_chars
			FROM dropped_calls
			JOIN tool_calls AS dropped
				ON dropped.digest = dropped_calls.digest
			JOIN tool_calls AS re_ask
				ON re_ask.session_id = dropped_calls.session_id
				AND re_ask.args_digest = dropped.args_digest
				AND re_ask.timestamp > dropped_calls.dropped_at_timestamp
			WHERE ${retrieval.sql} AND NOT (${changed.sql})
			GROUP BY dropped_calls.digest
			ORDER BY re_asked_at_timestamp ASC`,
			[...retrieval.params, ...changed.params],
		);
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
	async paybackReplay(): Promise<PaybackReplay> {
		const rows = await this.db.all<{
			dropped_before: number;
			remaining: number | null;
			retained: number | null;
			read_rate: number | null;
			write_rate: number | null;
		}>(
			`WITH rates AS (
				SELECT model,
					SUM(cost_cache_read) * 1.0 / SUM(tokens_cache_read) AS read_rate,
					SUM(cost_cache_write) * 1.0 / SUM(tokens_cache_write) AS write_rate
				FROM turns
				WHERE kind = 'assistant'
					AND tokens_cache_read > 0 AND tokens_cache_write > 0
				GROUP BY model
			),
			compactions AS (
				SELECT digest, session_id, timestamp, dropped_before, model
				FROM turns
				WHERE kind = 'compaction' AND dropped_before IS NOT NULL
			),
			after_turns AS (
				SELECT c.digest AS compaction_digest,
					t.tokens_input + t.tokens_cache_read + t.tokens_cache_write
						AS resident,
					ROW_NUMBER() OVER (
						PARTITION BY c.digest ORDER BY t.timestamp ASC
					) AS rn
				FROM compactions c
				JOIN turns t
					ON t.session_id = c.session_id AND t.timestamp > c.timestamp
			),
			after_agg AS (
				SELECT compaction_digest,
					COUNT(*) AS remaining,
					MAX(CASE WHEN rn = 1 THEN resident END) AS retained
				FROM after_turns
				GROUP BY compaction_digest
			)
			SELECT c.dropped_before AS dropped_before,
				a.remaining AS remaining,
				a.retained AS retained,
				r.read_rate AS read_rate,
				r.write_rate AS write_rate
			FROM compactions c
			LEFT JOIN after_agg a ON a.compaction_digest = c.digest
			LEFT JOIN rates r ON r.model = c.model`,
		);

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

	async recordSession(session: SessionRecord): Promise<void> {
		await this.db.run(
			`INSERT INTO sessions (
				session_id, cwd, repo, quest, first_seen, last_seen
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				cwd = excluded.cwd,
				repo = excluded.repo,
				quest = excluded.quest,
				first_seen = MIN(first_seen, excluded.first_seen),
				last_seen = MAX(last_seen, excluded.last_seen)`,
			[
				session.sessionId,
				session.cwd,
				session.repo,
				session.quest,
				session.firstSeen,
				session.lastSeen,
			],
		);
	}

	async costBy(dimension: CostDimension): Promise<CostSlice[]> {
		const column = GROUP_BY[dimension];
		const rows = await this.db.all<{
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

	async sessions(): Promise<SessionRecord[]> {
		const rows = await this.db.all<{
			session_id: string;
			cwd: string | null;
			repo: string | null;
			quest: string | null;
			first_seen: string | null;
			last_seen: string | null;
		}>(
			`SELECT session_id, cwd, repo, quest, first_seen, last_seen
			FROM sessions ORDER BY session_id`,
		);
		return rows.map((r) => ({
			sessionId: r.session_id,
			cwd: r.cwd,
			repo: r.repo,
			quest: r.quest,
			firstSeen: r.first_seen,
			lastSeen: r.last_seen,
		}));
	}

	async close(): Promise<void> {
		await this.db.close();
	}

	/**
	 * Give a held turn the facts a later scan learned. This is how a ledger
	 * indexed before a column existed gets it on the next rescan, and how a
	 * compaction indexed before its log said whether the run resumed gets
	 * told, without billing anything twice.
	 */
	private async fillFacts(t: TurnRecord): Promise<void> {
		const values = FACT_COLUMNS.map((f) => f.value(t));
		if (values.every((value) => value === null)) return;
		await this.db.run(FILL_FACTS, [...values, t.digest]);
	}

	private async sight(t: TurnRecord): Promise<void> {
		await this.db.run(
			"INSERT OR IGNORE INTO sightings (digest, session_id) VALUES (?, ?)",
			[t.digest, t.sessionId],
		);
	}

	/** Which of these call addresses the table already holds. */
	private async knownCalls(digests: readonly string[]): Promise<Set<string>> {
		return this.alreadyHeld("tool_calls", digests);
	}

	/** Which of these addresses the table already holds. */
	private async known(digests: readonly string[]): Promise<Set<string>> {
		return this.alreadyHeld("turns", digests);
	}

	/**
	 * Which of these digests a table already holds, probed in chunks so a
	 * corpus-sized batch stays inside SQLite's bound-variable ceiling.
	 */
	private async alreadyHeld(
		table: "turns" | "tool_calls" | "dropped_calls",
		digests: readonly string[],
	): Promise<Set<string>> {
		const found = new Set<string>();
		for (let i = 0; i < digests.length; i += PROBE_CHUNK) {
			const chunk = digests.slice(i, i + PROBE_CHUNK);
			const holes = chunk.map(() => "?").join(",");
			// The table name is a literal from a two-member union, not
			// caller input, so it cannot carry anything but itself.
			const rows = await this.db.all<{ digest: string }>(
				`SELECT digest FROM ${table} WHERE digest IN (${holes})`,
				chunk,
			);
			for (const r of rows) found.add(r.digest);
		}
		return found;
	}
}

/** A SQL fragment and the values its placeholders bind, in order. */
interface Clause {
	readonly sql: string;
	readonly params: readonly unknown[];
}

/**
 * `column IN (...)` over a caller's list, or a clause that holds for
 * every row when there is no list. An empty list means the caller named
 * nothing in scope, which is answered with nothing rather than
 * silently widened to everything.
 */
function inList(column: string, values: readonly string[] | undefined): Clause {
	if (values === undefined) return { sql: "1 = 1", params: [] };
	if (values.length === 0) return { sql: "1 = 0", params: [] };
	return {
		sql: `${column} IN (${values.map(() => "?").join(",")})`,
		params: values,
	};
}

/**
 * Whether a writer touched the file a call declares, strictly between
 * two moments in the same session. Holds for no row when no writers are
 * named or the call declares no file, since then nothing can have
 * changed underneath it that the ledger would know about.
 *
 * Column expressions are fixed fragments from this module, never caller
 * input; only the writer names are bound.
 */
function writtenBetween(
	call: string,
	after: string,
	before: string,
	writers: readonly string[] | undefined,
): Clause {
	if (writers === undefined || writers.length === 0) {
		return { sql: "1 = 0", params: [] };
	}
	return {
		sql: `${call}.path IS NOT NULL AND EXISTS (
			SELECT 1 FROM tool_calls AS written
			WHERE written.session_id = ${call}.session_id
				AND written.path = ${call}.path
				AND written.name IN (${writers.map(() => "?").join(",")})
				AND written.timestamp > ${after}
				AND written.timestamp < ${before}
		)`,
		params: writers,
	};
}

interface CallRow {
	digest: string;
	session_id: string;
	entry_id: string;
	call_id: string;
	timestamp: string;
	name: string;
	args_digest: string;
	path: string | null;
	result_chars: number | null;
	result_digest: string | null;
	is_error: number | null;
	verifier_kind: string | null;
}
