/**
 * The ledger's shape: its tables, the columns added since, the views a
 * query is written against, and the statements that write a turn.
 *
 * Apart from the store because the shape changes when a fact is added,
 * which touches the migration, the insert and the back-fill together,
 * while the store changes when how it writes does.
 */

import type { Db } from "../../internal/sqlite/db.ts";
import { sqlFile } from "../../internal/sqlite/sql-file.ts";
import type { TurnRecord } from "./types.ts";

/** The ledger's tables, made when missing; `migrate` adds later columns. */
const SCHEMA = sqlFile(new URL("./schema.sql", import.meta.url));

/**
 * Columns added to `turns` after its first shape, each with the record
 * field it holds. Declared once, because the migration that adds them,
 * the insert that writes them and the fill that back-dates them onto a
 * held turn must agree, and three lists drift.
 */
export const FACT_COLUMNS: ReadonlyArray<{
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
	{
		column: "reloaded",
		type: "INTEGER",
		value: (t) => flag(t.facts?.reloaded),
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
		column: "served_backend",
		type: "TEXT",
		value: (t) => t.facts?.servedBackend ?? null,
	},
	{
		column: "served_account",
		type: "TEXT",
		value: (t) => t.facts?.servedAccount ?? null,
	},
	{
		column: "served_edge",
		type: "TEXT",
		value: (t) => t.facts?.servedEdge ?? null,
	},
	{
		column: "account_changed",
		type: "INTEGER",
		value: (t) => flag(t.facts?.accountChanged),
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
export function questOf(turns: string, sessions: string): string {
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

/** The views a query is written against, made again on every open. */
const VIEWS = sqlFile(new URL("./views.sql", import.meta.url), {
	miss_slack_tokens: MISS_SLACK_TOKENS,
	miss_threshold_tokens: MISS_THRESHOLD_TOKENS,
	hour_ms: HOUR_MS,
	five_minutes_ms: FIVE_MINUTES_MS,
	full_miss_read_tokens: FULL_MISS_READ_TOKENS,
});

/**
 * Give a ledger this version's shape: its tables when missing, the
 * columns added since, and the views, made again on every open.
 */
export async function shapeLedger(db: Db): Promise<void> {
	await db.exec(SCHEMA);
	await migrate(db);
	await db.exec(VIEWS);
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

/** Write one turn, its first nineteen columns and then each fact's. */
export const INSERT_TURN = `INSERT OR IGNORE INTO turns (
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
export const FILL_FACTS = `UPDATE turns SET ${FACT_COLUMNS.map(
	(f) => `${f.column} = COALESCE(${f.column}, ?)`,
).join(", ")} WHERE digest = ?`;
