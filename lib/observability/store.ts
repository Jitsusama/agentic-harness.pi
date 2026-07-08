import { type Db, openDb } from "./db.js";
import type {
	RunRecord,
	RunRollup,
	RunSummary,
	VerifyOutcome,
} from "./types.js";

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
	rollupBefore(cutoffMs: number): Promise<{ rolledRows: number }>;
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
	return new SqliteRunStore(db);
}

class SqliteRunStore implements RunStore {
	constructor(private readonly db: Db) {}

	async recordRun(record: RunRecord): Promise<void> {
		await this.db.run(
			`INSERT INTO runs (
				run_id, subagent_id, kind, model, persona, verify_outcome,
				retries_to_valid, warning_count, exit_code,
				tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_total,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
				started_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				record.tokens.input,
				record.tokens.output,
				record.tokens.cacheRead,
				record.tokens.cacheWrite,
				record.tokens.total,
				record.cost.input,
				record.cost.output,
				record.cost.cacheRead,
				record.cost.cacheWrite,
				record.cost.total,
				record.startedAt,
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

	async rollupBefore(cutoffMs: number): Promise<{ rolledRows: number }> {
		const counted = await this.db.all<{ n: number }>(
			"SELECT COUNT(*) AS n FROM runs WHERE started_at < ?",
			[cutoffMs],
		);
		const rolledRows = counted[0]?.n ?? 0;
		if (rolledRows === 0) return { rolledRows: 0 };
		await this.db.run(
			`INSERT INTO rollups (
				week_start, model, persona, run_count, total_retries, total_warnings,
				tokens_total, cost_total, cache_read, fresh_input
			)
			SELECT
				(started_at / ${WEEK_MS}) * ${WEEK_MS} AS week_start,
				model, persona,
				COUNT(*), SUM(retries_to_valid), SUM(warning_count),
				SUM(tokens_total), SUM(cost_total),
				SUM(tokens_cache_read), SUM(tokens_input + tokens_cache_read)
			FROM runs WHERE started_at < ?
			GROUP BY week_start, model, persona
			ON CONFLICT(week_start, model, persona) DO UPDATE SET
				run_count = run_count + excluded.run_count,
				total_retries = total_retries + excluded.total_retries,
				total_warnings = total_warnings + excluded.total_warnings,
				tokens_total = tokens_total + excluded.tokens_total,
				cost_total = cost_total + excluded.cost_total,
				cache_read = cache_read + excluded.cache_read,
				fresh_input = fresh_input + excluded.fresh_input`,
			[cutoffMs],
		);
		await this.db.run("DELETE FROM runs WHERE started_at < ?", [cutoffMs]);
		return { rolledRows };
	}

	async queryRollups(): Promise<RunRollup[]> {
		const rows = await this.db.all<RollupRow>(
			"SELECT * FROM rollups ORDER BY week_start ASC, model ASC, persona ASC",
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
		startedAt: row.started_at,
	};
}
