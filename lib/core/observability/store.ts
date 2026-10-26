import { type Db, openDb } from "../internal/sqlite/db.ts";
import type {
	RunRecord,
	RunRollup,
	RunSummary,
	VerifyOutcome,
} from "./types.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Filter for {@link RunStore.queryRuns}. */
export interface RunQuery {
	readonly runId?: string;
}

/** A SQLite-backed store of subagent run records. */
export interface RunStore {
	recordRun(record: RunRecord): Promise<void>;
	queryRuns(filter?: RunQuery): Promise<RunRecord[]>;
	summarizeRun(runId: string): Promise<RunSummary | null>;
	/**
	 * Weekly per-model, per-persona summaries, computed from the rows
	 * rather than materialised beside them. Nothing has to run for this
	 * to be current, and no row is ever discarded to produce it.
	 */
	queryRollups(): Promise<RunRollup[]>;
	close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
	run_id TEXT NOT NULL,
	subagent_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	model TEXT NOT NULL,
	persona TEXT NOT NULL,
	verify_outcome TEXT NOT NULL,
	retries_to_valid INTEGER NOT NULL,
	warning_count INTEGER NOT NULL,
	exit_code INTEGER NOT NULL,
	tokens_input INTEGER NOT NULL,
	tokens_output INTEGER NOT NULL,
	tokens_cache_read INTEGER NOT NULL,
	tokens_cache_write INTEGER NOT NULL,
	tokens_total INTEGER NOT NULL,
	cost_input REAL NOT NULL,
	cost_output REAL NOT NULL,
	cost_cache_read REAL NOT NULL,
	cost_cache_write REAL NOT NULL,
	cost_total REAL NOT NULL,
	started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_run_id ON runs (run_id);
CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at);
/**
 * The rollups table is legacy and is never written to again. It holds
 * the only surviving record of 2,199 runs whose raw rows an earlier
 * retention pass deleted, so it is read and never dropped.
 */
CREATE TABLE IF NOT EXISTS rollups (
	week_start INTEGER NOT NULL,
	model TEXT NOT NULL,
	persona TEXT NOT NULL,
	run_count INTEGER NOT NULL,
	total_retries INTEGER NOT NULL,
	total_warnings INTEGER NOT NULL,
	tokens_total INTEGER NOT NULL,
	cost_total REAL NOT NULL,
	cache_read INTEGER NOT NULL,
	fresh_input INTEGER NOT NULL,
	PRIMARY KEY (week_start, model, persona)
);
`;

interface RunRow {
	run_id: string;
	subagent_id: string;
	kind: string;
	model: string;
	persona: string;
	verify_outcome: string;
	retries_to_valid: number;
	warning_count: number;
	exit_code: number;
	tokens_input: number;
	tokens_output: number;
	tokens_cache_read: number;
	tokens_cache_write: number;
	tokens_total: number;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
	started_at: number;
	metered: number;
	session_id: string | null;
	cwd: string | null;
	repo: string | null;
	ended_at: number | null;
	thinking_level: string | null;
	subagent_session_ids: string | null;
}

/**
 * Open (creating if needed) a run store at the given path.
 * WAL mode plus a busy timeout keep the single parent writer
 * safe against readers; subagents never touch the file.
 */
export async function openRunStore(dbPath: string): Promise<RunStore> {
	const db = await openDb(dbPath);
	await db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
	await db.exec(SCHEMA);
	await migrate(db);
	return new SqliteRunStore(db);
}

/**
 * Bring a store forward to the current shape, in place and without
 * losing a row.
 *
 * This is the only schema path: a new store is created at the original
 * shape and migrated like any other, so every test that opens a fresh
 * store also exercises the migration an existing file will meet.
 * Every step is additive, a column or an index, so nothing a store
 * already holds can be lost by opening it.
 */
async function migrate(db: Db): Promise<void> {
	const columns = new Set(
		(await db.all<{ name: string }>("PRAGMA table_info(runs)")).map(
			(column) => column.name,
		),
	);

	if (!columns.has("metered")) {
		await db.exec(
			"ALTER TABLE runs ADD COLUMN metered INTEGER NOT NULL DEFAULT 1",
		);
		// Rows written before this column existed recorded an unmetered
		// run as zero cost. Zero tokens identifies them: a run that did
		// anything consumed some, and all 75 such rows in the real store
		// had none. Only backfilled on the pass that adds the column, so
		// a later metered run cannot be reclassified.
		await db.exec(
			"UPDATE runs SET metered = 0 WHERE tokens_total = 0 AND cost_total = 0",
		);
	}

	for (const [name, type] of [...ATTRIBUTION_COLUMNS, ...LAUNCH_COLUMNS]) {
		if (!columns.has(name)) {
			await db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
		}
	}

	const indexes = await db.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_identity'",
	);
	if (indexes.length === 0) {
		// A subagent of a run is one row. A store written before that rule
		// may hold duplicates, and the index cannot be added over them.
		// They are captured before anything is removed, keeping the latest
		// of each pair where it was: nothing is deleted that is not first
		// copied somewhere it can be recovered from.
		await db.exec(
			`CREATE TABLE IF NOT EXISTS runs_superseded AS SELECT * FROM runs WHERE 0;
			INSERT INTO runs_superseded SELECT * FROM runs WHERE rowid NOT IN (
				SELECT MAX(rowid) FROM runs GROUP BY run_id, subagent_id
			);
			DELETE FROM runs WHERE rowid NOT IN (
				SELECT MAX(rowid) FROM runs GROUP BY run_id, subagent_id
			);
			CREATE UNIQUE INDEX runs_identity ON runs (run_id, subagent_id);`,
		);
	}
}

/**
 * Where a run belonged, all nullable because a row written before these
 * existed does not know, and a guess would charge work that did not
 * incur the cost.
 */
const ATTRIBUTION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
	["session_id", "TEXT"],
	["cwd", "TEXT"],
	["repo", "TEXT"],
	["ended_at", "INTEGER"],
];

/**
 * How a run was launched, nullable for the same reason: rows written
 * before these existed never said.
 */
const LAUNCH_COLUMNS: ReadonlyArray<readonly [string, string]> = [
	["thinking_level", "TEXT"],
	// A JSON array of session ids; null when not known.
	["subagent_session_ids", "TEXT"],
];

class SqliteRunStore implements RunStore {
	constructor(private readonly db: Db) {}

	async recordRun(record: RunRecord): Promise<void> {
		await this.db.run(
			`INSERT INTO runs (
				run_id, subagent_id, kind, model, persona, verify_outcome,
				retries_to_valid, warning_count, exit_code,
				tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_total,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
				started_at, metered, session_id, cwd, repo, ended_at,
				thinking_level, subagent_session_ids
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (run_id, subagent_id) DO UPDATE SET
				kind = excluded.kind, model = excluded.model,
				persona = excluded.persona, verify_outcome = excluded.verify_outcome,
				retries_to_valid = excluded.retries_to_valid,
				warning_count = excluded.warning_count,
				exit_code = excluded.exit_code,
				tokens_input = excluded.tokens_input,
				tokens_output = excluded.tokens_output,
				tokens_cache_read = excluded.tokens_cache_read,
				tokens_cache_write = excluded.tokens_cache_write,
				tokens_total = excluded.tokens_total,
				cost_input = excluded.cost_input,
				cost_output = excluded.cost_output,
				cost_cache_read = excluded.cost_cache_read,
				cost_cache_write = excluded.cost_cache_write,
				cost_total = excluded.cost_total,
				started_at = excluded.started_at, metered = excluded.metered,
				session_id = excluded.session_id, cwd = excluded.cwd,
				repo = excluded.repo, ended_at = excluded.ended_at,
				thinking_level = excluded.thinking_level,
				subagent_session_ids = excluded.subagent_session_ids`,
			[
				record.runId,
				record.subagentId,
				record.kind,
				record.model,
				record.persona,
				record.verifyOutcome,
				record.retriesToValid,
				record.warningCount,
				record.exitCode,
				// An unmetered run stores zeros, which leave every sum exactly
				// as excluding it would, and the flag beside them is what says
				// the zeros are unknown rather than free.
				record.tokens?.input ?? 0,
				record.tokens?.output ?? 0,
				record.tokens?.cacheRead ?? 0,
				record.tokens?.cacheWrite ?? 0,
				record.tokens?.total ?? 0,
				record.cost?.input ?? 0,
				record.cost?.output ?? 0,
				record.cost?.cacheRead ?? 0,
				record.cost?.cacheWrite ?? 0,
				record.cost?.total ?? 0,
				record.startedAt,
				record.cost ? 1 : 0,
				record.sessionId ?? null,
				record.cwd ?? null,
				record.repo ?? null,
				record.endedAt ?? null,
				record.thinkingLevel ?? null,
				record.subagentSessionIds
					? JSON.stringify(record.subagentSessionIds)
					: null,
			],
		);
	}

	async queryRuns(filter: RunQuery = {}): Promise<RunRecord[]> {
		const where = filter.runId ? "WHERE run_id = ?" : "";
		const params = filter.runId ? [filter.runId] : [];
		const rows = await this.db.all<RunRow>(
			`SELECT * FROM runs ${where} ORDER BY started_at ASC`,
			params,
		);
		return rows.map(rowToRecord);
	}

	async summarizeRun(runId: string): Promise<RunSummary | null> {
		const rows = await this.db.all<SummaryRow>(
			`SELECT
				COUNT(*) AS subagent_count,
				SUM(CASE WHEN verify_outcome = 'passed' THEN 1 ELSE 0 END) AS passed,
				SUM(CASE WHEN verify_outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
				SUM(retries_to_valid) AS total_retries,
				SUM(warning_count) AS total_warnings,
				SUM(CASE WHEN metered = 0 THEN 1 ELSE 0 END) AS unmetered,
				SUM(tokens_input) AS tokens_input,
				SUM(tokens_output) AS tokens_output,
				SUM(tokens_cache_read) AS tokens_cache_read,
				SUM(tokens_cache_write) AS tokens_cache_write,
				SUM(tokens_total) AS tokens_total,
				SUM(cost_input) AS cost_input,
				SUM(cost_output) AS cost_output,
				SUM(cost_cache_read) AS cost_cache_read,
				SUM(cost_cache_write) AS cost_cache_write,
				SUM(cost_total) AS cost_total
			FROM runs WHERE run_id = ?`,
			[runId],
		);
		const row = rows[0];
		if (!row || row.subagent_count === 0) return null;
		const freshInput = row.tokens_input + row.tokens_cache_read;
		return {
			runId,
			subagentCount: row.subagent_count,
			passed: row.passed,
			failed: row.failed,
			totalRetries: row.total_retries,
			totalWarnings: row.total_warnings,
			unmetered: row.unmetered,
			tokens: {
				input: row.tokens_input,
				output: row.tokens_output,
				cacheRead: row.tokens_cache_read,
				cacheWrite: row.tokens_cache_write,
				total: row.tokens_total,
			},
			cost: {
				input: row.cost_input,
				output: row.cost_output,
				cacheRead: row.cost_cache_read,
				cacheWrite: row.cost_cache_write,
				total: row.cost_total,
			},
			cacheReadRatio: freshInput === 0 ? 0 : row.tokens_cache_read / freshInput,
		};
	}

	/**
	 * Summaries over every row held, unioned with the legacy table.
	 *
	 * Computed rather than materialised, because the only reason to
	 * materialise was that the rows behind it were being deleted. They
	 * are not any more: the whole corpus is a rounding error on disk and
	 * discarding detail to save it was never a trade worth making.
	 *
	 * The legacy rows are unioned in rather than ignored, since for the
	 * period before this changed they are all that is left.
	 */
	async queryRollups(): Promise<RunRollup[]> {
		const rows = await this.db.all<RollupRow>(
			`SELECT * FROM (
				SELECT
					(started_at / ${WEEK_MS}) * ${WEEK_MS} AS week_start,
					model, persona,
					COUNT(*) AS run_count,
					SUM(retries_to_valid) AS total_retries,
					SUM(warning_count) AS total_warnings,
					SUM(tokens_total) AS tokens_total,
					SUM(cost_total) AS cost_total,
					SUM(tokens_cache_read) AS cache_read,
					SUM(tokens_input + tokens_cache_read) AS fresh_input
				FROM runs GROUP BY week_start, model, persona
				UNION ALL
				SELECT week_start, model, persona, run_count, total_retries,
					total_warnings, tokens_total, cost_total, cache_read, fresh_input
				FROM rollups
			)
			ORDER BY week_start ASC, model ASC, persona ASC`,
		);
		return rows.map((row) => ({
			weekStart: row.week_start,
			model: row.model,
			persona: row.persona,
			runCount: row.run_count,
			totalRetries: row.total_retries,
			totalWarnings: row.total_warnings,
			tokensTotal: row.tokens_total,
			costTotal: row.cost_total,
			cacheReadRatio:
				row.fresh_input === 0 ? 0 : row.cache_read / row.fresh_input,
		}));
	}

	async close(): Promise<void> {
		await this.db.close();
	}
}

interface RollupRow {
	week_start: number;
	model: string;
	persona: string;
	run_count: number;
	total_retries: number;
	total_warnings: number;
	tokens_total: number;
	cost_total: number;
	cache_read: number;
	fresh_input: number;
}

interface SummaryRow {
	subagent_count: number;
	passed: number;
	failed: number;
	total_retries: number;
	total_warnings: number;
	unmetered: number;
	tokens_input: number;
	tokens_output: number;
	tokens_cache_read: number;
	tokens_cache_write: number;
	tokens_total: number;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
}

/**
 * Read the stored session list back. Anything that is not an array of
 * strings reads as unknown rather than as a partial list, since a list
 * with a session missing would join a job to less of its bill without
 * saying so.
 */
function sessionIdsFrom(stored: string | null): readonly string[] | null {
	if (stored === null) return null;
	try {
		const parsed: unknown = JSON.parse(stored);
		return Array.isArray(parsed) &&
			parsed.every((id): id is string => typeof id === "string")
			? parsed
			: null;
	} catch {
		// Not JSON, so not something this store wrote: unknown.
		return null;
	}
}

function rowToRecord(row: RunRow): RunRecord {
	return {
		runId: row.run_id,
		subagentId: row.subagent_id,
		kind: row.kind,
		model: row.model,
		persona: row.persona,
		verifyOutcome: row.verify_outcome as VerifyOutcome,
		retriesToValid: row.retries_to_valid,
		warningCount: row.warning_count,
		exitCode: row.exit_code,
		tokens:
			row.metered === 0
				? null
				: {
						input: row.tokens_input,
						output: row.tokens_output,
						cacheRead: row.tokens_cache_read,
						cacheWrite: row.tokens_cache_write,
						total: row.tokens_total,
					},
		cost:
			row.metered === 0
				? null
				: {
						input: row.cost_input,
						output: row.cost_output,
						cacheRead: row.cost_cache_read,
						cacheWrite: row.cost_cache_write,
						total: row.cost_total,
					},
		startedAt: row.started_at,
		sessionId: row.session_id ?? null,
		cwd: row.cwd ?? null,
		repo: row.repo ?? null,
		endedAt: row.ended_at ?? null,
		thinkingLevel: row.thinking_level ?? null,
		subagentSessionIds: sessionIdsFrom(row.subagent_session_ids),
	};
}
